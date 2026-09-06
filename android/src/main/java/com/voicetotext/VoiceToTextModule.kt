package com.voicetotext

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

@ReactModule(name = VoiceToTextModule.NAME)
class VoiceToTextModule(reactContext: ReactApplicationContext) :
  NativeVoiceToTextSpec(reactContext) {

  private val mainHandler = Handler(Looper.getMainLooper())

  // Recognizer state — main thread only.
  private var speechRecognizer: SpeechRecognizer? = null

  /** Between startListening() and the terminal callback, or stop/destroy. */
  private var isListening = false

  /** Between startListening() and onSpeechEnd for the current session. */
  private var sessionOpen = false

  /** Whether the recognizer has heard speech yet in the current segment. */
  private var speechDetected = false

  /** Latest non-empty partial, used to recover text when the recognizer errors instead of finishing normally. */
  private var lastPartialResults: Bundle? = null

  /** Set by startListening({continuous: true}): keeps the session alive past the recognizer's own silence cut-off. */
  private var continuous = false

  /** Whether stopListening() has been called for the current session. */
  private var stopRequested = false

  /** Text of the segments a continuous session has already finished, joined by spaces. */
  private var accumulatedText = ""

  /** Whether onSpeechStart has fired for the current session, so re-armed segments don't repeat it. */
  private var startEmitted = false

  /** Retry bookkeeping for transparent rebinds after a service-connection error. */
  private var retryCount = 0
  private var pendingRetry: Runnable? = null

  /** Language chosen through setRecognitionLanguage(); null means the device default. */
  @Volatile private var preferredLanguageTag: String? = null

  // NativeEventEmitter only reports a total count on removeListeners, so we
  // track it ourselves to know when the high-frequency events can stop.
  private val listenerCount = AtomicInteger(0)
  private val volumeRequested = AtomicBoolean(false)
  private val audioBufferRequested = AtomicBoolean(false)

  override fun getName(): String = NAME

  override fun invalidate() {
    super.invalidate()
    mainHandler.post { releaseRecognizer() }
  }

  // ---------------------------------------------------------------------------
  // Recognizer lifecycle (main thread only)
  // ---------------------------------------------------------------------------

  private fun buildRecognizerIntent(): Intent {
    val languageTag = preferredLanguageTag ?: Locale.getDefault().toLanguageTag()
    return Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
      // The recognizer reads these as strings; passing a Locale object is ignored.
      putExtra(RecognizerIntent.EXTRA_LANGUAGE, languageTag)
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, languageTag)
      putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5)
      putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, reactApplicationContext.packageName)
      if (continuous) {
        // Hint only — most devices ignore it, hence the re-arm logic below.
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, CONTINUOUS_SILENCE_MS)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, CONTINUOUS_SILENCE_MS)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, CONTINUOUS_MIN_LENGTH_MS)
      }
    }
  }

  /** Destroys the current recognizer, if any, without touching the JS session. */
  private fun destroyRecognizer() {
    try {
      speechRecognizer?.destroy()
    } catch (e: Exception) {
      Log.w(TAG, "Error destroying SpeechRecognizer", e)
    }
    speechRecognizer = null
    isListening = false
  }

  /** Tears down the recognizer and closes an open session so JS always sees one END per START. */
  private fun releaseRecognizer() {
    cancelPendingRetry()
    endSession()
    destroyRecognizer()
  }

  /**
   * Creates a fresh recognizer, or null if recognition isn't available.
   * A recognizer that has errored once tends to keep failing, so we never reuse one across sessions.
   */
  private fun newRecognizer(): SpeechRecognizer? {
    if (!SpeechRecognizer.isRecognitionAvailable(reactApplicationContext)) {
      return null
    }
    val recognizer = SpeechRecognizer.createSpeechRecognizer(reactApplicationContext)
    // A dedicated listener per instance so a late callback from a destroyed
    // recognizer can't affect the one that replaced it.
    recognizer.setRecognitionListener(SessionListener(recognizer))
    speechRecognizer = recognizer
    speechDetected = false
    lastPartialResults = null
    return recognizer
  }

  /** Closes whatever session is still open and creates the recognizer for a new one. */
  private fun createRecognizer(): SpeechRecognizer? {
    releaseRecognizer()
    return newRecognizer()
  }

  private fun endSession() {
    if (!sessionOpen) return
    sessionOpen = false
    isListening = false
    startEmitted = false
    sendEvent("onSpeechEnd", null)
  }

  /** Closes the session, delivering whatever text was recognised so far as the final result. Returns false if there is none. */
  private fun finishWithPendingText(): Boolean {
    val partial = lastPartialResults
    if (partial == null && accumulatedText.isEmpty()) return false
    lastPartialResults = null
    sendEvent("onSpeechResults", buildResultsPayload(partial, isFinal = true))
    endSession()
    return true
  }

  /** Continuous mode: appends a finished segment's text to the session text. */
  private fun bankSegment(segmentText: String) {
    lastPartialResults = null
    if (segmentText.isBlank()) return
    accumulatedText = if (accumulatedText.isEmpty()) segmentText.trim() else "$accumulatedText ${segmentText.trim()}"
    // Refresh the caller's view now that the banked text has grown.
    sendEvent("onSpeechPartialResults", buildResultsPayload(null, isFinal = false))
  }

  /** Starts a new recognition segment on [recognizer] for the open session. */
  private fun armSegment(recognizer: SpeechRecognizer): Boolean {
    speechDetected = false
    lastPartialResults = null
    return try {
      recognizer.startListening(buildRecognizerIntent())
      isListening = true
      true
    } catch (e: Exception) {
      Log.e(TAG, "Could not start speech recognizer", e)
      false
    }
  }

  /**
   * The recognizer closed a segment on its own; bank its text and start the next one on the
   * *same* recognizer instance, so JS still only sees one START/END for the whole session.
   * Destroying and recreating the recognizer here would rebind the recognition service too
   * fast and trigger ERROR_SERVER_DISCONNECTED.
   */
  private fun continueSession(segmentText: String) {
    bankSegment(segmentText)
    val recognizer = speechRecognizer
    if (recognizer == null || !armSegment(recognizer)) {
      if (!scheduleRetry(SpeechRecognizer.ERROR_CLIENT)) {
        failSession(SpeechRecognizer.ERROR_CLIENT, "Could not re-arm speech recognizer")
      }
    }
  }

  /** Rebinds with a fresh recognizer after a service-connection error. False once retries are exhausted. */
  private fun scheduleRetry(code: Int): Boolean {
    if (stopRequested || retryCount >= MAX_RETRIES) return false
    retryCount++
    Log.w(TAG, "${errorMessage(code)}; rebinding recognizer (attempt $retryCount of $MAX_RETRIES)")
    if (continuous) bankSegment(bestText(lastPartialResults))
    cancelPendingRetry()
    destroyRecognizer()
    val retry = Runnable {
      pendingRetry = null
      if (!sessionOpen || stopRequested) return@Runnable
      val recognizer = newRecognizer()
      if (recognizer == null || !armSegment(recognizer)) {
        failSession(code, errorMessage(code))
      }
    }
    pendingRetry = retry
    mainHandler.postDelayed(retry, RETRY_DELAY_MS)
    return true
  }

  private fun cancelPendingRetry() {
    pendingRetry?.let { mainHandler.removeCallbacks(it) }
    pendingRetry = null
  }

  /** Reports [code] to JS and closes the session, keeping any text recognised so far. */
  private fun failSession(code: Int, message: String) {
    sendError(code, message)
    if (!finishWithPendingText()) endSession()
    destroyRecognizer()
  }

  private fun sendError(code: Int, message: String) {
    val params = Arguments.createMap()
    params.putInt("code", code)
    params.putString("message", message)
    sendEvent("onSpeechError", params)
  }

  private fun hasTranscription(bundle: Bundle?): Boolean =
    bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
      ?.any { it.isNotBlank() } == true

  /** Best transcription in the bundle, or "" when there is none. */
  private fun bestText(bundle: Bundle?): String =
    bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()

  /** Prefixes a segment's text with the banked text of a continuous session. */
  private fun withAccumulated(text: String): String = when {
    accumulatedText.isEmpty() -> text
    text.isBlank() -> accumulatedText
    else -> "$accumulatedText $text"
  }

  // ---------------------------------------------------------------------------
  // RecognitionListener (callbacks arrive on the main thread)
  // ---------------------------------------------------------------------------

  private inner class SessionListener(private val owner: SpeechRecognizer) : RecognitionListener {
    /** Callbacks from a recognizer that is no longer the current one are dropped. */
    private fun isStale(): Boolean = speechRecognizer !== owner

    override fun onReadyForSpeech(params: Bundle?) {
      if (isStale()) return
      // Re-armed segments and retries must not repeat the session's START.
      if (startEmitted) return
      startEmitted = true
      sendEvent("onSpeechStart", null)
    }

    override fun onBeginningOfSpeech() {
      if (isStale()) return
      speechDetected = true
      sendEvent("onSpeechBegin", null)
    }

    override fun onRmsChanged(rmsdB: Float) {
      if (isStale() || !volumeRequested.get()) return
      val params = Arguments.createMap()
      params.putDouble("value", rmsdB.toDouble())
      sendEvent("onSpeechVolumeChanged", params)
    }

    override fun onBufferReceived(buffer: ByteArray?) {
      if (isStale() || buffer == null || !audioBufferRequested.get()) return
      val params = Arguments.createMap()
      // android.util.Base64 works on every supported API level; java.util.Base64 needs API 26.
      params.putString("buffer", Base64.encodeToString(buffer, Base64.NO_WRAP))
      sendEvent("onSpeechAudioBuffer", params)
    }

    override fun onEndOfSpeech() {
      // Results or an error are still on their way; the session stays open.
      Log.d(TAG, "onEndOfSpeech")
    }

    override fun onError(error: Int) {
      if (isStale()) {
        Log.d(TAG, "Ignoring onError(${errorMessage(error)}) from a released recognizer")
        return
      }
      val noSpeech = error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
      val connection = error == ERROR_SERVER_DISCONNECTED ||
        error == SpeechRecognizer.ERROR_CLIENT ||
        error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY
      // The recognizer gave up on a pause; a continuous session just carries on.
      if (noSpeech && continuous && !stopRequested) {
        Log.d(TAG, "onError(${errorMessage(error)}) in continuous mode; re-arming")
        continueSession(bestText(lastPartialResults))
        return
      }
      // Rebind quietly when nothing is lost: continuous sessions have their
      // text banked, and single-shot sessions haven't started talking yet.
      if (connection && (continuous || !speechDetected) && scheduleRetry(error)) return
      // A connection drop right after stopListening() isn't worth reporting.
      if (connection && stopRequested) {
        if (!finishWithPendingText()) endSession()
        return
      }
      // "Nothing recognised" after the recognizer already gave us text is a
      // quirk of the platform recognizer, not an error. Deliver the text.
      if (noSpeech && finishWithPendingText()) {
        Log.d(TAG, "onError(${errorMessage(error)}) after partial results; delivered pending text as final")
        return
      }
      Log.d(TAG, "onError: ${errorMessage(error)}")
      sendError(error, errorMessage(error))
      // Do not throw away text that was already recognised.
      if (!finishWithPendingText()) endSession()
    }

    override fun onResults(results: Bundle?) {
      if (isStale()) return
      if (continuous && !stopRequested) {
        continueSession(bestText(results).ifEmpty { bestText(lastPartialResults) })
        return
      }
      // An empty final bundle after partials were delivered; keep the text.
      if (!hasTranscription(results) && finishWithPendingText()) return
      lastPartialResults = null
      sendEvent("onSpeechResults", buildResultsPayload(results, isFinal = true))
      endSession()
    }

    override fun onPartialResults(partialResults: Bundle?) {
      if (isStale()) return
      if (hasTranscription(partialResults)) {
        speechDetected = true
        lastPartialResults = partialResults
      }
      sendEvent("onSpeechPartialResults", buildResultsPayload(partialResults, isFinal = false))
    }

    override fun onEvent(eventType: Int, params: Bundle?) {
      if (isStale()) return
      val eventParams = Arguments.createMap()
      eventParams.putInt("eventType", eventType)
      if (params != null) {
        for (key in params.keySet()) {
          @Suppress("DEPRECATION")
          when (val value = params.get(key)) {
            is String -> eventParams.putString(key, value)
            is Int -> eventParams.putInt(key, value)
            is Long -> eventParams.putDouble(key, value.toDouble())
            is Float -> eventParams.putDouble(key, value.toDouble())
            is Double -> eventParams.putDouble(key, value)
            is Boolean -> eventParams.putBoolean(key, value)
          }
        }
      }
      sendEvent("onSpeechEvent", eventParams)
    }
  }

  private fun errorMessage(error: Int): String = when (error) {
    SpeechRecognizer.ERROR_NETWORK -> "Network error"
    SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Network timeout"
    SpeechRecognizer.ERROR_NO_MATCH -> "No speech match found"
    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Recognizer is busy"
    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Insufficient permissions"
    SpeechRecognizer.ERROR_SERVER -> "Server error"
    SpeechRecognizer.ERROR_CLIENT -> "Client error"
    SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Speech timeout"
    SpeechRecognizer.ERROR_AUDIO -> "Audio recording error"
    // Codes 10-15 were added in API 31-34; spelled out as literals so this
    // compiles against older compileSdk versions too.
    ERROR_TOO_MANY_REQUESTS -> "Too many requests to the recognition service"
    ERROR_SERVER_DISCONNECTED -> "Recognition service disconnected"
    ERROR_LANGUAGE_NOT_SUPPORTED -> "Language not supported by the recognizer"
    ERROR_LANGUAGE_UNAVAILABLE -> "Language not available on this device"
    ERROR_CANNOT_CHECK_SUPPORT -> "Cannot check language support"
    ERROR_CANNOT_LISTEN_TO_DOWNLOAD_EVENTS -> "Cannot listen to model download events"
    else -> "Unknown error: $error"
  }

  private fun buildResultsPayload(bundle: Bundle?, isFinal: Boolean): WritableMap {
    var matches: List<String> = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION) ?: emptyList()
    // Nothing from the current segment, but the session already has text.
    if (matches.isEmpty() && accumulatedText.isNotEmpty()) {
      matches = listOf("")
    }
    val confidence = if (isFinal) bundle?.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES) else null

    val transcriptions = Arguments.createArray()
    matches.forEachIndexed { index, text ->
      val transcription = Arguments.createMap()
      transcription.putString("text", withAccumulated(text))
      val score = if (confidence != null && index < confidence.size) confidence[index].toDouble() else 0.0
      transcription.putDouble("confidence", score)
      transcriptions.pushMap(transcription)
    }

    val resultsMap = Arguments.createMap()
    resultsMap.putArray("transcriptions", transcriptions)

    val params = Arguments.createMap()
    params.putString("value", withAccumulated(matches.firstOrNull() ?: ""))
    params.putBoolean("isFinal", isFinal)
    params.putMap("results", resultsMap)
    return params
  }

  private fun sendEvent(eventName: String, params: WritableMap?) {
    val context = reactApplicationContext
    if (!context.hasActiveReactInstance()) return
    try {
      context
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(eventName, params)
    } catch (e: Exception) {
      Log.e(TAG, "Error sending event: $eventName", e)
    }
  }

  // ---------------------------------------------------------------------------
  // JS API
  // ---------------------------------------------------------------------------

  override fun startListening(options: ReadableMap, promise: Promise) {
    if (ContextCompat.checkSelfPermission(reactApplicationContext, Manifest.permission.RECORD_AUDIO)
      != PackageManager.PERMISSION_GRANTED
    ) {
      promise.reject("PERMISSION_DENIED", "Audio recording permission not granted")
      return
    }
    val wantContinuous = options.hasKey("continuous") &&
      !options.isNull("continuous") &&
      options.getBoolean("continuous")

    mainHandler.post {
      if (isListening) {
        promise.reject("ALREADY_LISTENING", "Speech recognition already in progress")
        return@post
      }

      val recognizer = createRecognizer()
      if (recognizer == null) {
        promise.reject("NOT_AVAILABLE", "Speech recognition is not available on this device")
        return@post
      }

      continuous = wantContinuous
      stopRequested = false
      accumulatedText = ""
      startEmitted = false
      retryCount = 0

      try {
        recognizer.startListening(buildRecognizerIntent())
        isListening = true
        sessionOpen = true
        promise.resolve("Started listening")
      } catch (e: Exception) {
        Log.e(TAG, "Error starting speech recognition", e)
        releaseRecognizer()
        promise.reject("START_ERROR", "Could not start speech recognition: ${e.message}", e)
      }
    }
  }

  override fun stopListening(promise: Promise) {
    mainHandler.post {
      val recognizer = speechRecognizer
      if (recognizer == null || !isListening) {
        if (sessionOpen) {
          // Mid-retry, or waiting on a final result that never came.
          stopRequested = true
          finishWithPendingText()
          releaseRecognizer()
          promise.resolve("Stopped listening")
        } else {
          promise.resolve("Not listening")
        }
        return@post
      }

      stopRequested = true

      // Recognizers tend to ignore stopListening() before any speech was
      // heard, so cancel outright rather than waiting for a result.
      if (!speechDetected) {
        try {
          recognizer.cancel()
        } catch (e: Exception) {
          Log.w(TAG, "Error cancelling speech recognition", e)
        }
        finishWithPendingText()
        releaseRecognizer()
        promise.resolve("Stopped listening")
        return@post
      }

      try {
        // The recognizer answers with onResults or onError, which closes the session.
        recognizer.stopListening()
        isListening = false
        promise.resolve("Stopped listening")
      } catch (e: Exception) {
        Log.e(TAG, "Error stopping speech recognition", e)
        releaseRecognizer()
        promise.reject("STOP_ERROR", "Error stopping speech recognition: ${e.message}", e)
        return@post
      }

      // Fallback for recognizers that never deliver a terminal callback.
      mainHandler.postDelayed({
        if (sessionOpen && speechRecognizer === recognizer) {
          Log.d(TAG, "No terminal callback after stopListening; closing session")
          finishWithPendingText()
          releaseRecognizer()
        }
      }, STOP_TIMEOUT_MS)
    }
  }

  override fun destroy(promise: Promise) {
    mainHandler.post {
      releaseRecognizer()
      promise.resolve("Speech recognizer destroyed")
    }
  }

  override fun addListener(eventName: String) {
    listenerCount.incrementAndGet()
    when (eventName) {
      "onSpeechVolumeChanged" -> volumeRequested.set(true)
      "onSpeechAudioBuffer" -> audioBufferRequested.set(true)
    }
  }

  override fun removeListeners(count: Double) {
    val toRemove = count.toInt()
    val remaining = listenerCount.updateAndGet { current -> maxOf(0, current - toRemove) }
    if (remaining == 0) {
      volumeRequested.set(false)
      audioBufferRequested.set(false)
    }
  }

  override fun getRecognitionLanguage(promise: Promise) {
    promise.resolve(preferredLanguageTag ?: Locale.getDefault().toLanguageTag())
  }

  override fun setRecognitionLanguage(languageTag: String, promise: Promise) {
    val tag = languageTag.trim()
    if (tag.isEmpty()) {
      promise.reject("LANGUAGE_ERROR", "Language tag must not be empty")
      return
    }
    // Applied to the next startListening(); a running session keeps its language.
    preferredLanguageTag = tag
    promise.resolve(true)
  }

  override fun isRecognitionAvailable(promise: Promise) {
    promise.resolve(SpeechRecognizer.isRecognitionAvailable(reactApplicationContext))
  }

  override fun getSupportedLanguages(promise: Promise) {
    // Android has no synchronous API for this; ACTION_GET_LANGUAGE_DETAILS is a
    // broadcast that many recognizer implementations never answer. Return the
    // set of tags that are broadly supported by the platform recognizer.
    val languages = Arguments.createArray()
    listOf(
      "en-US", "en-GB", "fr-FR", "de-DE", "it-IT", "es-ES",
      "ja-JP", "ko-KR", "zh-CN", "ru-RU", "pt-BR", "nl-NL",
      "hi-IN", "ar-SA"
    ).forEach { languages.pushString(it) }
    promise.resolve(languages)
  }

  companion object {
    const val NAME = "VoiceToText"
    private const val TAG = "VoiceToTextModule"
    private const val STOP_TIMEOUT_MS = 5000L
    private const val CONTINUOUS_SILENCE_MS = 5000L
    private const val CONTINUOUS_MIN_LENGTH_MS = 10000L
    private const val MAX_RETRIES = 3
    private const val RETRY_DELAY_MS = 300L

    // SpeechRecognizer.ERROR_* values that only exist on newer SDKs.
    private const val ERROR_TOO_MANY_REQUESTS = 10 // API 31
    private const val ERROR_SERVER_DISCONNECTED = 11 // API 31
    private const val ERROR_LANGUAGE_NOT_SUPPORTED = 12 // API 31
    private const val ERROR_LANGUAGE_UNAVAILABLE = 13 // API 31
    private const val ERROR_CANNOT_CHECK_SUPPORT = 14 // API 33
    private const val ERROR_CANNOT_LISTEN_TO_DOWNLOAD_EVENTS = 15 // API 34
  }
}

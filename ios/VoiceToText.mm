#import "VoiceToText.h"
#import <React/RCTLog.h>
#import <atomic>

// Errors Speech.framework reports when a task is cancelled by us. They are not
// surfaced to JS because they follow every stopListening()/destroy().
static BOOL VTTIsCancellationError(NSError *error)
{
  if (error == nil) {
    return NO;
  }
  if ([error.domain isEqualToString:@"kAFAssistantErrorDomain"] && error.code == 216) {
    return YES;
  }
  if ([error.domain isEqualToString:@"kLSRErrorDomain"] && error.code == 301) {
    return YES;
  }
  return NO;
}

// Errors that mean "the recognizer heard nothing / gave up waiting", not that
// something is broken: 1110 "No speech detected", 203 "Retry" (session timeout).
static BOOL VTTIsNoSpeechError(NSError *error)
{
  if (error == nil || ![error.domain isEqualToString:@"kAFAssistantErrorDomain"]) {
    return NO;
  }
  return error.code == 1110 || error.code == 203;
}

static NSString *VTTLanguageTagForLocale(NSLocale *locale)
{
  NSString *language = [locale objectForKey:NSLocaleLanguageCode];
  NSString *country = [locale objectForKey:NSLocaleCountryCode];
  if (language.length == 0) {
    return [locale.localeIdentifier stringByReplacingOccurrencesOfString:@"_" withString:@"-"];
  }
  return country.length > 0 ? [NSString stringWithFormat:@"%@-%@", language, country] : language;
}

static const int64_t kStopTimeoutNanos = 5 * NSEC_PER_SEC;

@implementation VoiceToText {
  // Read on the audio render thread, written on the main queue.
  std::atomic<bool> _hasListeners;
  std::atomic<bool> _volumeRequested;
  std::atomic<bool> _audioBufferRequested;

  // Everything below is main-queue only.
  BOOL _tapInstalled;
  BOOL _audioSessionActive;
  BOOL _speechBegan;
  BOOL _sessionOpen; // Between a successful start and onSpeechEnd.
  NSUInteger _sessionId; // Bumped per startListening()/destroy(); tags late async callbacks.
  NSUInteger _segmentId; // Bumped each time a task is (re)armed within a session.
  BOOL _continuous; // Set by startListening({continuous: true}).
  BOOL _stopRequested;
  NSString *_accumulatedText; // Text of segments a continuous session has already finished.
  NSString *_lastPartialText; // Best transcription of the current segment's latest partial.
}

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

// All exported methods, Speech callbacks and AVAudioEngine work run here.
- (dispatch_queue_t)methodQueue
{
  return dispatch_get_main_queue();
}

- (instancetype)init
{
  if (self = [super init]) {
    _isListening = NO;
    _hasListeners = false;
    _volumeRequested = false;
    _audioBufferRequested = false;
    _accumulatedText = @"";
  }
  return self;
}

- (void)invalidate
{
  [super invalidate];
  dispatch_async(dispatch_get_main_queue(), ^{
    [self teardownEverything];
  });
}

#pragma mark - Events

- (NSArray<NSString *> *)supportedEvents
{
  return @[
    @"onSpeechStart",
    @"onSpeechBegin",
    @"onSpeechEnd",
    @"onSpeechResults",
    @"onSpeechPartialResults",
    @"onSpeechError",
    @"onSpeechVolumeChanged",
    @"onSpeechEvent",
    @"onSpeechAudioBuffer"
  ];
}

- (void)startObserving
{
  _hasListeners = true;
}

- (void)stopObserving
{
  _hasListeners = false;
  _volumeRequested = false;
  _audioBufferRequested = false;
}

// Must call super — RCTEventEmitter uses these to toggle start/stopObserving.
- (void)addListener:(NSString *)eventName
{
  [super addListener:eventName];
  if ([eventName isEqualToString:@"onSpeechVolumeChanged"]) {
    _volumeRequested = true;
  } else if ([eventName isEqualToString:@"onSpeechAudioBuffer"]) {
    _audioBufferRequested = true;
  }
}

- (void)removeListeners:(double)count
{
  [super removeListeners:count];
}

- (void)sendEventWithName:(NSString *)name body:(id)body
{
  if (_hasListeners) {
    [super sendEventWithName:name body:body];
  }
}

- (void)sendError:(NSString *)message code:(NSInteger)code
{
  [self sendEventWithName:@"onSpeechError" body:@{@"message" : message ?: @"", @"code" : @(code)}];
}

#pragma mark - Audio session

- (NSError *)activateAudioSession
{
  NSError *error = nil;
  AVAudioSession *session = [AVAudioSession sharedInstance];
  // PlayAndRecord keeps the host app's own playback working; plain Record mutes it.
  BOOL ok = [session setCategory:AVAudioSessionCategoryPlayAndRecord
                            mode:AVAudioSessionModeMeasurement
                         options:AVAudioSessionCategoryOptionDuckOthers | AVAudioSessionCategoryOptionDefaultToSpeaker
                           error:&error];
  if (!ok) {
    return error ?: [NSError errorWithDomain:@"VoiceToText" code:-100 userInfo:@{NSLocalizedDescriptionKey : @"Could not configure audio session"}];
  }
  ok = [session setActive:YES withOptions:0 error:&error];
  if (!ok) {
    return error ?: [NSError errorWithDomain:@"VoiceToText" code:-102 userInfo:@{NSLocalizedDescriptionKey : @"Could not activate audio session"}];
  }
  _audioSessionActive = YES;
  return nil;
}

- (void)deactivateAudioSession
{
  if (!_audioSessionActive) {
    return;
  }
  _audioSessionActive = NO;
  NSError *error = nil;
  if (![[AVAudioSession sharedInstance] setActive:NO
                                     withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
                                           error:&error]) {
    RCTLogWarn(@"VoiceToText: could not deactivate audio session: %@", error);
  }
}

#pragma mark - Session lifecycle

/// Stops feeding audio into the request; the task is left running so a final result can still arrive.
- (void)stopAudioCapture
{
  if (_tapInstalled) {
    [_audioEngine.inputNode removeTapOnBus:0];
    _tapInstalled = NO;
  }
  if (_audioEngine.isRunning) {
    [_audioEngine stop];
  }
  [_recognitionRequest endAudio];
  _recognitionRequest = nil;
  [self deactivateAudioSession];
}

/// Closes the live session: no more audio, task released, one onSpeechEnd.
- (void)endCurrentSession
{
  [self stopAudioCapture];
  _recognitionTask = nil;
  _isListening = NO;
  _lastPartialText = nil;
  if (_sessionOpen) {
    _sessionOpen = NO;
    [self sendEventWithName:@"onSpeechEnd" body:nil];
  }
}

/// Text recognised so far but not yet delivered as a final result.
- (NSString *)pendingText
{
  return [self withAccumulated:_lastPartialText ?: @""];
}

/// Closes the session with the pending text as the final result. Returns NO if there is none.
- (BOOL)finishWithPendingText
{
  NSString *text = [self pendingText];
  if (text.length == 0) {
    return NO;
  }
  _lastPartialText = nil;
  [self sendEventWithName:@"onSpeechResults" body:[self payloadForText:text isFinal:YES]];
  [self endCurrentSession];
  return YES;
}

- (NSString *)withAccumulated:(NSString *)text
{
  if (_accumulatedText.length == 0) {
    return text ?: @"";
  }
  if (text.length == 0) {
    return _accumulatedText;
  }
  return [NSString stringWithFormat:@"%@ %@", _accumulatedText, text];
}

/// Cancels whatever is in flight and invalidates pending permission callbacks.
- (void)cancelCurrentSession
{
  _sessionId++;
  SFSpeechRecognitionTask *task = _recognitionTask;
  [self endCurrentSession];
  [task cancel];
}

- (void)teardownEverything
{
  [self cancelCurrentSession];
  _speechRecognizer = nil;
  _audioEngine = nil;
}

#pragma mark - Permissions

- (void)requestRecordPermission:(void (^)(BOOL granted))completion
{
#if defined(__IPHONE_17_0) && __IPHONE_OS_VERSION_MAX_ALLOWED >= __IPHONE_17_0
  if (@available(iOS 17.0, *)) {
    [AVAudioApplication requestRecordPermissionWithCompletionHandler:completion];
    return;
  }
#endif
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  [[AVAudioSession sharedInstance] requestRecordPermission:completion];
#pragma clang diagnostic pop
}

#pragma mark - startListening

RCT_EXPORT_METHOD(startListening
                  : (NSDictionary *)options resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)
{
  if (_isListening) {
    reject(@"ALREADY_LISTENING", @"Speech recognition already in progress", nil);
    return;
  }

  // A previous session may still be waiting on its final result; close it
  // now so START/END pairs stay in order.
  if (_sessionOpen) {
    [self cancelCurrentSession];
  }

  // Set before the async permission checks so a second call meanwhile is
  // rejected instead of installing a second audio tap.
  _isListening = YES;
  _continuous = [options[@"continuous"] isKindOfClass:[NSNumber class]] && [options[@"continuous"] boolValue];
  _stopRequested = NO;
  _accumulatedText = @"";
  _lastPartialText = nil;
  NSUInteger sessionId = ++_sessionId;

  __weak VoiceToText *weakSelf = self;
  [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
    dispatch_async(dispatch_get_main_queue(), ^{
      VoiceToText *strongSelf = weakSelf;
      if (strongSelf == nil) {
        reject(@"DESTROYED", @"VoiceToText module was released", nil);
        return;
      }
      if (sessionId != strongSelf->_sessionId) {
        reject(@"CANCELLED", @"startListening was superseded by destroy() or another call", nil);
        return;
      }

      switch (status) {
        case SFSpeechRecognizerAuthorizationStatusAuthorized:
          break;
        case SFSpeechRecognizerAuthorizationStatusDenied:
          strongSelf.isListening = NO;
          reject(@"PERMISSION_DENIED", @"Speech recognition permission denied", nil);
          return;
        case SFSpeechRecognizerAuthorizationStatusRestricted:
          strongSelf.isListening = NO;
          reject(@"PERMISSION_RESTRICTED", @"Speech recognition restricted on this device", nil);
          return;
        case SFSpeechRecognizerAuthorizationStatusNotDetermined:
          strongSelf.isListening = NO;
          reject(@"PERMISSION_NOT_DETERMINED", @"Speech recognition permission not determined", nil);
          return;
      }

      [strongSelf requestRecordPermission:^(BOOL granted) {
        dispatch_async(dispatch_get_main_queue(), ^{
          VoiceToText *innerSelf = weakSelf;
          if (innerSelf == nil) {
            reject(@"DESTROYED", @"VoiceToText module was released", nil);
            return;
          }
          if (sessionId != innerSelf->_sessionId) {
            reject(@"CANCELLED", @"startListening was superseded by destroy() or another call", nil);
            return;
          }
          if (!granted) {
            innerSelf.isListening = NO;
            reject(@"PERMISSION_DENIED", @"Microphone permission denied", nil);
            return;
          }
          [innerSelf beginSession:sessionId resolve:resolve reject:reject];
        });
      }];
    });
  }];
}

- (void)failStartWithCode:(NSString *)code
                  message:(NSString *)message
                    error:(NSError *)error
                   reject:(RCTPromiseRejectBlock)reject
{
  RCTLogWarn(@"VoiceToText: %@ (%@)", message, error);
  SFSpeechRecognitionTask *task = _recognitionTask;
  [self stopAudioCapture];
  _recognitionTask = nil;
  [task cancel];
  _sessionOpen = NO;
  _isListening = NO;
  reject(code, message, error);
}

- (void)beginSession:(NSUInteger)sessionId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if (_speechRecognizer == nil) {
    _speechRecognizer = [[SFSpeechRecognizer alloc] initWithLocale:[NSLocale currentLocale]];
  }
  if (_speechRecognizer == nil) {
    [self failStartWithCode:@"NOT_AVAILABLE" message:@"Speech recognition not available for the current locale" error:nil reject:reject];
    return;
  }
  if (!_speechRecognizer.isAvailable) {
    [self failStartWithCode:@"NOT_AVAILABLE" message:@"Speech recognition not currently available" error:nil reject:reject];
    return;
  }

  NSError *sessionError = [self activateAudioSession];
  if (sessionError != nil) {
    [self failStartWithCode:@"AUDIO_ERROR"
                    message:[NSString stringWithFormat:@"Could not configure audio session: %@", sessionError.localizedDescription]
                      error:sessionError
                     reject:reject];
    return;
  }

  if (_audioEngine == nil) {
    _audioEngine = [[AVAudioEngine alloc] init];
  }
  AVAudioInputNode *inputNode = _audioEngine.inputNode;
  AVAudioFormat *format = [inputNode outputFormatForBus:0];
  // A 0 Hz / 0 channel format means no usable microphone; installTapOnBus:
  // would throw an uncatchable exception on it.
  if (format == nil || format.sampleRate <= 0 || format.channelCount == 0) {
    [self failStartWithCode:@"AUDIO_ERROR"
                    message:@"No audio input is available (microphone missing, in use, or permission denied)"
                      error:nil
                     reject:reject];
    return;
  }

  _sessionOpen = YES;
  [self armRecognitionSegmentForSession:sessionId inputNode:inputNode format:format];

  [_audioEngine prepare];
  NSError *engineError = nil;
  if (![_audioEngine startAndReturnError:&engineError]) {
    [self failStartWithCode:@"AUDIO_ERROR"
                    message:[NSString stringWithFormat:@"Could not start audio engine: %@", engineError.localizedDescription]
                      error:engineError
                     reject:reject];
    return;
  }

  [self sendEventWithName:@"onSpeechStart" body:nil];
  resolve(@"Started listening");
}

/// Creates the request/task for one segment and routes the mic tap into it.
/// Called once per session, and again whenever a continuous session re-arms.
- (void)armRecognitionSegmentForSession:(NSUInteger)sessionId
                              inputNode:(AVAudioInputNode *)inputNode
                                 format:(AVAudioFormat *)format
{
  NSUInteger segmentId = ++_segmentId;

  SFSpeechAudioBufferRecognitionRequest *request = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
  request.shouldReportPartialResults = YES;
  request.taskHint = SFSpeechRecognitionTaskHintDictation;
  _recognitionRequest = request;
  _speechBegan = NO;
  _lastPartialText = nil;

  __weak VoiceToText *weakSelf = self;
  _recognitionTask = [_speechRecognizer
      recognitionTaskWithRequest:request
                   resultHandler:^(SFSpeechRecognitionResult *_Nullable result, NSError *_Nullable error) {
                     dispatch_async(dispatch_get_main_queue(), ^{
                       [weakSelf handleResult:result error:error sessionId:sessionId segmentId:segmentId];
                     });
                   }];

  if (_tapInstalled) {
    // Should never happen, but a second tap on the same bus is a hard crash.
    [inputNode removeTapOnBus:0];
    _tapInstalled = NO;
  }
  [inputNode installTapOnBus:0
                  bufferSize:1024
                      format:format
                       block:^(AVAudioPCMBuffer *_Nonnull buffer, AVAudioTime *_Nonnull when) {
                         // Audio thread: only touch atomics and the captured request.
                         [request appendAudioPCMBuffer:buffer];

                         VoiceToText *tapSelf = weakSelf;
                         if (tapSelf == nil || buffer.frameLength == 0) {
                           return;
                         }
                         BOOL wantVolume = tapSelf->_volumeRequested.load();
                         BOOL wantBuffer = tapSelf->_audioBufferRequested.load();
                         if (!wantVolume && !wantBuffer) {
                           return;
                         }
                         float *const *channels = buffer.floatChannelData;
                         if (channels == NULL || channels[0] == NULL) {
                           return; // Not a float PCM format.
                         }
                         const float *samples = channels[0];
                         const AVAudioFrameCount frames = buffer.frameLength;

                         if (wantVolume) {
                           float sum = 0.0f;
                           for (AVAudioFrameCount i = 0; i < frames; i++) {
                             sum += samples[i] * samples[i];
                           }
                           float rms = sqrtf(sum / (float)frames);
                           dispatch_async(dispatch_get_main_queue(), ^{
                             [tapSelf sendEventWithName:@"onSpeechVolumeChanged" body:@{@"value" : @(rms)}];
                           });
                         }

                         if (wantBuffer) {
                           NSData *audioData = [NSData dataWithBytes:samples length:frames * sizeof(float)];
                           NSString *base64Audio = [audioData base64EncodedStringWithOptions:0];
                           dispatch_async(dispatch_get_main_queue(), ^{
                             [tapSelf sendEventWithName:@"onSpeechAudioBuffer" body:@{@"buffer" : base64Audio}];
                           });
                         }
                       }];
  _tapInstalled = YES;
}

/// A segment finished on its own in continuous mode: bank its text and arm a
/// fresh task on the still-running audio engine, without closing the session.
- (void)continueSession:(NSUInteger)sessionId withSegmentText:(NSString *)segmentText
{
  NSString *trimmed = [segmentText stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (trimmed.length > 0) {
    _accumulatedText = _accumulatedText.length > 0 ? [NSString stringWithFormat:@"%@ %@", _accumulatedText, trimmed] : trimmed;
    [self sendEventWithName:@"onSpeechPartialResults" body:[self payloadForText:_accumulatedText isFinal:NO]];
  }
  _lastPartialText = nil;

  SFSpeechRecognitionTask *finishedTask = _recognitionTask;
  _recognitionTask = nil;
  [finishedTask cancel];

  if (_audioEngine == nil || !_audioEngine.isRunning) {
    NSError *engineError = nil;
    if (_audioEngine == nil || ![_audioEngine startAndReturnError:&engineError]) {
      RCTLogWarn(@"VoiceToText: could not re-arm audio engine: %@", engineError);
      [self sendError:[NSString stringWithFormat:@"Could not re-arm audio engine: %@", engineError.localizedDescription ?: @"unknown"]
                 code:engineError.code];
      if (![self finishWithPendingText]) {
        [self endCurrentSession];
      }
      return;
    }
  }

  AVAudioInputNode *inputNode = _audioEngine.inputNode;
  [self armRecognitionSegmentForSession:sessionId inputNode:inputNode format:[inputNode outputFormatForBus:0]];
}

#pragma mark - Results

/// Payload for text the library synthesises itself (banked/pending text).
- (NSDictionary *)payloadForText:(NSString *)text isFinal:(BOOL)isFinal
{
  return @{
    @"value" : text ?: @"",
    @"isFinal" : @(isFinal),
    @"results" : @{@"transcriptions" : @[ @{@"text" : text ?: @"", @"confidence" : @0, @"segments" : @[]} ]}
  };
}

- (NSDictionary *)payloadForResult:(SFSpeechRecognitionResult *)result
{
  NSMutableArray *transcriptions = [NSMutableArray new];
  for (SFTranscription *transcription in result.transcriptions) {
    NSMutableArray *segments = [NSMutableArray new];
    double confidenceSum = 0;
    for (SFTranscriptionSegment *segment in transcription.segments) {
      confidenceSum += segment.confidence;
      [segments addObject:@{@"text" : segment.substring ?: @"", @"confidence" : @(segment.confidence)}];
    }
    double confidence = segments.count > 0 ? confidenceSum / segments.count : 0;
    [transcriptions addObject:@{
      @"text" : [self withAccumulated:transcription.formattedString],
      @"confidence" : @(confidence),
      @"segments" : segments
    }];
  }
  return @{
    @"value" : [self withAccumulated:result.bestTranscription.formattedString],
    @"isFinal" : @(result.isFinal),
    @"results" : @{@"transcriptions" : transcriptions}
  };
}

- (void)handleResult:(SFSpeechRecognitionResult *)result
               error:(NSError *)error
           sessionId:(NSUInteger)sessionId
           segmentId:(NSUInteger)segmentId
{
  // Drop callbacks from a cancelled, superseded or already re-armed task.
  if (sessionId != _sessionId || segmentId != _segmentId || !_sessionOpen) {
    return;
  }

  BOOL isFinal = result != nil && result.isFinal;
  NSString *segmentText = result.bestTranscription.formattedString ?: @"";
  BOOL noSpeech = VTTIsNoSpeechError(error);
  // Segment ended on its own but the caller still wants to listen: carry on.
  BOOL carryOn = _continuous && !_stopRequested && (isFinal || noSpeech);

  if (result != nil) {
    if (!_speechBegan && segmentText.length > 0) {
      _speechBegan = YES;
      [self sendEventWithName:@"onSpeechBegin" body:nil];
    }
    if (!isFinal && segmentText.length > 0) {
      _lastPartialText = segmentText;
    }
    if (!carryOn) {
      [self sendEventWithName:isFinal ? @"onSpeechResults" : @"onSpeechPartialResults" body:[self payloadForResult:result]];
    }
  }

  if (carryOn) {
    [self continueSession:sessionId withSegmentText:isFinal ? segmentText : (_lastPartialText ?: @"")];
    return;
  }

  if (error != nil && !VTTIsCancellationError(error)) {
    // "Heard nothing" after text was already recognised isn't a real error.
    if (noSpeech && [self finishWithPendingText]) {
      return;
    }
    RCTLogWarn(@"VoiceToText: recognition error: %@", error);
    [self sendError:[NSString stringWithFormat:@"Recognition error: %@", error.localizedDescription] code:error.code];
  }

  if (isFinal) {
    _lastPartialText = nil;
    [self endCurrentSession];
  } else if (error != nil) {
    if (![self finishWithPendingText]) {
      [self endCurrentSession];
    }
  }
}

#pragma mark - stopListening / destroy

RCT_EXPORT_METHOD(stopListening : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  if (!_isListening) {
    resolve(@"Not listening");
    return;
  }

  _isListening = NO;
  _stopRequested = YES;
  SFSpeechRecognitionTask *task = _recognitionTask;
  // finish (not cancel) keeps the task alive so the final result still arrives.
  [self stopAudioCapture];
  [task finish];
  resolve(@"Stopped listening");

  // Fallback for the rare case Speech.framework never completes the task.
  NSUInteger sessionId = _sessionId;
  __weak VoiceToText *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, kStopTimeoutNanos), dispatch_get_main_queue(), ^{
    VoiceToText *strongSelf = weakSelf;
    if (strongSelf != nil && strongSelf->_sessionOpen && strongSelf->_sessionId == sessionId) {
      RCTLogWarn(@"VoiceToText: no final result after stopListening; closing session");
      if (![strongSelf finishWithPendingText]) {
        [strongSelf endCurrentSession];
      }
      [task cancel];
    }
  });
}

RCT_EXPORT_METHOD(destroy : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  [self teardownEverything];
  resolve(@"Speech recognizer destroyed");
}

#pragma mark - Languages

RCT_EXPORT_METHOD(getRecognitionLanguage : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  NSLocale *locale = _speechRecognizer.locale ?: [NSLocale currentLocale];
  resolve(VTTLanguageTagForLocale(locale));
}

RCT_EXPORT_METHOD(setRecognitionLanguage
                  : (NSString *)languageTag resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)
{
  if (languageTag.length == 0) {
    reject(@"LANGUAGE_ERROR", @"Language tag must not be empty", nil);
    return;
  }
  NSLocale *locale = [[NSLocale alloc] initWithLocaleIdentifier:languageTag];
  SFSpeechRecognizer *recognizer = [[SFSpeechRecognizer alloc] initWithLocale:locale]; // nil if unsupported
  if (recognizer == nil) {
    reject(@"LANGUAGE_ERROR", [NSString stringWithFormat:@"Speech recognition is not supported for '%@'", languageTag], nil);
    return;
  }
  if (!recognizer.isAvailable) {
    reject(@"LANGUAGE_ERROR", [NSString stringWithFormat:@"Speech recognition is not currently available for '%@'", languageTag], nil);
    return;
  }
  // Applied to the next startListening(); a running session keeps its recognizer.
  _speechRecognizer = recognizer;
  resolve(@YES);
}

RCT_EXPORT_METHOD(isRecognitionAvailable : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  SFSpeechRecognizer *recognizer = _speechRecognizer ?: [[SFSpeechRecognizer alloc] initWithLocale:[NSLocale currentLocale]];
  resolve(@(recognizer != nil && recognizer.isAvailable));
}

RCT_EXPORT_METHOD(getSupportedLanguages : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  NSMutableArray<NSString *> *tags = [NSMutableArray new];
  for (NSLocale *locale in [SFSpeechRecognizer supportedLocales]) {
    [tags addObject:VTTLanguageTagForLocale(locale)];
  }
  [tags sortUsingSelector:@selector(localizedCaseInsensitiveCompare:)];
  resolve(tags);
}

#pragma mark - TurboModule

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeVoiceToTextSpecJSI>(params);
}
#endif

@end

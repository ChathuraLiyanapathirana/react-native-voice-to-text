import { NativeEventEmitter, type EmitterSubscription } from 'react-native';
import VoiceToText from './NativeVoiceToText';

export const VoiceToTextEvents = {
  START: 'onSpeechStart',
  BEGIN: 'onSpeechBegin',
  END: 'onSpeechEnd',
  ERROR: 'onSpeechError',
  RESULTS: 'onSpeechResults',
  PARTIAL_RESULTS: 'onSpeechPartialResults',
  VOLUME_CHANGED: 'onSpeechVolumeChanged',
  AUDIO_BUFFER: 'onSpeechAudioBuffer',
  EVENT: 'onSpeechEvent',
} as const;

export type VoiceToTextEventName =
  (typeof VoiceToTextEvents)[keyof typeof VoiceToTextEvents];

export interface TranscriptionSegment {
  text: string;
  confidence: number;
}

export interface Transcription {
  text: string;
  /**
   * 0..1. Android reports it only on final results; iOS reports the average
   * of its segment confidences. 0 when unknown.
   */
  confidence: number;
  /** iOS only. */
  segments?: TranscriptionSegment[];
}

export interface SpeechResultsEvent {
  /** Best transcription. */
  value: string;
  isFinal: boolean;
  results: { transcriptions: Transcription[] };
}

export interface SpeechErrorEvent {
  /** Platform error code (android.speech.SpeechRecognizer.ERROR_* or NSError.code). */
  code: number;
  message: string;
}

export interface SpeechVolumeEvent {
  /** Android: RMS in dB as reported by the recognizer. iOS: linear RMS of the last buffer (0..1). */
  value: number;
}

export interface SpeechAudioBufferEvent {
  /** Base64. Android: raw bytes from the recognizer. iOS: 32-bit float PCM, first channel. */
  buffer: string;
}

export interface SpeechEvent {
  eventType: number;
  [key: string]: string | number | boolean;
}

export interface VoiceToTextEventMap {
  onSpeechStart: undefined;
  onSpeechBegin: undefined;
  onSpeechEnd: undefined;
  onSpeechError: SpeechErrorEvent;
  onSpeechResults: SpeechResultsEvent;
  onSpeechPartialResults: SpeechResultsEvent;
  onSpeechVolumeChanged: SpeechVolumeEvent;
  onSpeechAudioBuffer: SpeechAudioBufferEvent;
  onSpeechEvent: SpeechEvent;
}

let emitter: NativeEventEmitter | undefined;

// Created on first use rather than at import time so merely importing the
// library does not instantiate the native module.
function getEmitter(): NativeEventEmitter {
  if (!emitter) {
    emitter = new NativeEventEmitter(VoiceToText);
  }
  return emitter;
}

export interface StartListeningOptions {
  /**
   * Keep listening past pauses until `stopListening()` is called, instead of
   * ending after the first one (push-to-talk, dictation). See "Continuous
   * mode" in the README for what changes in the emitted events. Default `false`.
   */
  continuous?: boolean;
}

/** Starts a recognition session. Rejects if one is already running or the device can't recognise speech. */
export function startListening(
  options: StartListeningOptions = {}
): Promise<string> {
  return VoiceToText.startListening({
    continuous: options.continuous === true,
  });
}

/** Stops capturing audio. The session's final `RESULTS` (if any) and `END` still follow. */
export function stopListening(): Promise<string> {
  return VoiceToText.stopListening();
}

/** Cancels any running session and releases native resources. `startListening()` works again afterwards. */
export function destroy(): Promise<string> {
  return VoiceToText.destroy();
}

/** Returns the language tag (e.g. `"en-US"`) that the next session will use. */
export function getRecognitionLanguage(): Promise<string> {
  return VoiceToText.getRecognitionLanguage();
}

/** Sets the language tag (e.g. `"en-US"`) for the next `startListening()`. A running session is unaffected. */
export function setRecognitionLanguage(languageTag: string): Promise<boolean> {
  return VoiceToText.setRecognitionLanguage(languageTag);
}

/** Whether the device can perform speech recognition at all. */
export function isRecognitionAvailable(): Promise<boolean> {
  return VoiceToText.isRecognitionAvailable();
}

/** Lists the language tags the device reports as recognisable. */
export function getSupportedLanguages(): Promise<string[]> {
  return VoiceToText.getSupportedLanguages();
}

/** Subscribes to one of `VoiceToTextEvents`. Call `.remove()` on the result when done. */
export function addEventListener<E extends VoiceToTextEventName>(
  eventName: E,
  handler: (event: VoiceToTextEventMap[E]) => void
): EmitterSubscription;
export function addEventListener(
  eventName: string,
  handler: (event: any) => void
): EmitterSubscription;
export function addEventListener(
  eventName: string,
  handler: (event: any) => void
): EmitterSubscription {
  return getEmitter().addListener(eventName, handler);
}

/** Removes every listener registered for the given event. */
export function removeAllListeners(eventName: string): void {
  getEmitter().removeAllListeners(eventName);
}

export default {
  startListening,
  stopListening,
  destroy,
  getRecognitionLanguage,
  setRecognitionLanguage,
  isRecognitionAvailable,
  getSupportedLanguages,
  addEventListener,
  removeAllListeners,
  ...VoiceToTextEvents,
};

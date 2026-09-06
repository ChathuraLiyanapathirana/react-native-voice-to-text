import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  // Object, not a typed shape, so codegen passes it through as a plain
  // NSDictionary/ReadableMap. See StartListeningOptions in index.tsx.
  startListening(options: Object): Promise<string>;
  stopListening(): Promise<string>;
  destroy(): Promise<string>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
  getRecognitionLanguage(): Promise<string>;
  setRecognitionLanguage(languageTag: string): Promise<boolean>;
  isRecognitionAvailable(): Promise<boolean>;
  getSupportedLanguages(): Promise<string[]>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('VoiceToText');

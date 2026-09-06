import { NativeEventEmitter } from 'react-native';
import NativeVoiceToText from '../NativeVoiceToText';
import VoiceToText, {
  VoiceToTextEvents,
  addEventListener,
  removeAllListeners,
  startListening,
} from '../index';

jest.mock('../NativeVoiceToText', () => ({
  __esModule: true,
  default: {
    startListening: jest.fn(() => Promise.resolve('Started listening')),
    stopListening: jest.fn(() => Promise.resolve('Stopped listening')),
    destroy: jest.fn(() => Promise.resolve('Speech recognizer destroyed')),
    getRecognitionLanguage: jest.fn(() => Promise.resolve('en-US')),
    setRecognitionLanguage: jest.fn(() => Promise.resolve(true)),
    isRecognitionAvailable: jest.fn(() => Promise.resolve(true)),
    getSupportedLanguages: jest.fn(() => Promise.resolve(['en-US'])),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  },
}));

jest.mock('react-native', () => {
  const emitter = {
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    removeAllListeners: jest.fn(),
  };
  return { NativeEventEmitter: jest.fn(() => emitter) };
});

const MockedNativeEventEmitter = NativeEventEmitter as unknown as jest.Mock;
const nativeModule = NativeVoiceToText as jest.Mocked<typeof NativeVoiceToText>;
// The mocked constructor hands back the same emitter object every time.
const nativeEmitter = () => new MockedNativeEventEmitter();

describe('VoiceToText JS wrapper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not construct the emitter until a listener is added', () => {
    expect(MockedNativeEventEmitter).not.toHaveBeenCalled();
    addEventListener(VoiceToTextEvents.RESULTS, () => {});
    expect(MockedNativeEventEmitter).toHaveBeenCalledTimes(1);
    expect(MockedNativeEventEmitter).toHaveBeenCalledWith(nativeModule);
  });

  it('reuses a single emitter across calls', () => {
    addEventListener(VoiceToTextEvents.START, () => {});
    addEventListener(VoiceToTextEvents.END, () => {});
    removeAllListeners(VoiceToTextEvents.END);
    expect(MockedNativeEventEmitter).not.toHaveBeenCalled();
    const emitter = nativeEmitter();
    expect(emitter.addListener).toHaveBeenCalledTimes(2);
    expect(emitter.removeAllListeners).toHaveBeenCalledWith(
      VoiceToTextEvents.END
    );
  });

  it('always hands the native module a normalised options object', async () => {
    await startListening();
    expect(nativeModule.startListening).toHaveBeenLastCalledWith({
      continuous: false,
    });
    await startListening({ continuous: true });
    expect(nativeModule.startListening).toHaveBeenLastCalledWith({
      continuous: true,
    });
  });

  it('forwards method calls to the native module', async () => {
    await expect(startListening()).resolves.toBe('Started listening');
    await expect(VoiceToText.stopListening()).resolves.toBe(
      'Stopped listening'
    );
    await expect(VoiceToText.setRecognitionLanguage('fr-FR')).resolves.toBe(
      true
    );
    expect(nativeModule.setRecognitionLanguage).toHaveBeenCalledWith('fr-FR');
  });

  it('exposes event names on the default export', () => {
    expect(VoiceToText.RESULTS).toBe('onSpeechResults');
    expect(VoiceToText.END).toBe('onSpeechEnd');
  });
});

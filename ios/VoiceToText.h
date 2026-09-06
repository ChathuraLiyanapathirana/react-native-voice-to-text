#import <Foundation/Foundation.h>
#import <Speech/Speech.h>
#import <AVFoundation/AVFoundation.h>
#import <React/RCTEventEmitter.h>

// The New Architecture builds this module as a TurboModule against the
// codegen'd spec. When the app is on the legacy bridge (RCT_NEW_ARCH_ENABLED
// unset) the generated headers are not available, so we fall back to the
// classic RCTBridgeModule protocol. The exported methods and events are the
// same in both modes; only the transport differs.
#ifdef RCT_NEW_ARCH_ENABLED
#import "generated/RNVoiceToTextSpec/RNVoiceToTextSpec.h"
@interface VoiceToText : RCTEventEmitter <NativeVoiceToTextSpec>
#else
#import <React/RCTBridgeModule.h>
@interface VoiceToText : RCTEventEmitter <RCTBridgeModule>
#endif

@property (nonatomic, strong, nullable) SFSpeechRecognizer *speechRecognizer;
@property (nonatomic, strong, nullable) SFSpeechAudioBufferRecognitionRequest *recognitionRequest;
@property (nonatomic, strong, nullable) SFSpeechRecognitionTask *recognitionTask;
@property (nonatomic, strong, nullable) AVAudioEngine *audioEngine;
@property (nonatomic) BOOL isListening;

@end

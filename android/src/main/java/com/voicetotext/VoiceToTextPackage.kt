package com.voicetotext

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import java.util.HashMap

class VoiceToTextPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
    return if (name == VoiceToTextModule.NAME) {
      VoiceToTextModule(reactContext)
    } else {
      null
    }
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider {
      val moduleInfos: MutableMap<String, ReactModuleInfo> = HashMap()
      moduleInfos[VoiceToTextModule.NAME] = ReactModuleInfo(
        VoiceToTextModule.NAME,
        VoiceToTextModule.NAME,
        false,  // canOverrideExistingModule
        false,  // needsEagerInit
        false,  // isCxxModule
        // On the legacy bridge the module is served from the classic
        // NativeModule registry; on the New Architecture from TurboModuleManager.
        BuildConfig.IS_NEW_ARCHITECTURE_ENABLED // isTurboModule
      )
      moduleInfos
    }
  }
}

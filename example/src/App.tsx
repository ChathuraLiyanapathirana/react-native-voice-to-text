import { useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import VoiceToText, {
  VoiceToTextEvents,
} from '@appcitor/react-native-voice-to-text';

// Shown when the platform cannot list its languages (older Android recognizers).
const FALLBACK_LANGUAGES = [
  'en-US',
  'en-GB',
  'fr-FR',
  'de-DE',
  'it-IT',
  'es-ES',
  'ja-JP',
  'ko-KR',
  'zh-CN',
  'ru-RU',
  'pt-BR',
];

const colors = {
  background: '#F4F6F8',
  card: '#FFFFFF',
  border: '#E3E7EC',
  text: '#1B1F23',
  muted: '#6B7280',
  primary: '#1F6FEB',
  primaryPressed: '#175BC4',
  danger: '#D64545',
  success: '#1E8E5A',
};

export default function App() {
  const [transcript, setTranscript] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isHolding, setIsHolding] = useState(false);
  const [isAvailable, setIsAvailable] = useState(false);
  const [currentLanguage, setCurrentLanguage] = useState('');
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [supportedLanguages, setSupportedLanguages] = useState<string[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
  const [initialized, setInitialized] = useState(false);

  const requestMicrophonePermission = async () => {
    try {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          {
            title: 'Microphone Permission',
            message:
              'This app needs access to your microphone for speech recognition',
            buttonNeutral: 'Ask Me Later',
            buttonNegative: 'Cancel',
            buttonPositive: 'OK',
          }
        );

        if (granted === PermissionsAndroid.RESULTS.GRANTED) {
          setPermissionGranted(true);
          return true;
        }
        Alert.alert(
          'Permission Required',
          'Microphone permission is required for speech recognition'
        );
        return false;
      }
      // iOS prompts on first use; the library reports a denial as an error.
      setPermissionGranted(true);
      return true;
    } catch (error) {
      console.error('Error requesting microphone permission:', error);
      return false;
    }
  };

  useEffect(() => {
    const initialize = async () => {
      const hasPermission = await requestMicrophonePermission();
      if (!hasPermission) {
        setInitialized(true);
        return;
      }

      try {
        const available = await VoiceToText.isRecognitionAvailable();
        setIsAvailable(available);
        if (!available) return;

        setCurrentLanguage(await VoiceToText.getRecognitionLanguage());
        try {
          const languages = await VoiceToText.getSupportedLanguages();
          setSupportedLanguages(
            languages.length > 0 ? languages : FALLBACK_LANGUAGES
          );
        } catch (langError) {
          console.error('Error getting supported languages:', langError);
          setSupportedLanguages(FALLBACK_LANGUAGES);
        }
      } catch (error) {
        console.error(error);
      } finally {
        setInitialized(true);
      }
    };

    initialize();

    const subscriptions = [
      VoiceToText.addEventListener(VoiceToTextEvents.START, () => {
        setIsListening(true);
      }),
      VoiceToText.addEventListener(VoiceToTextEvents.END, () => {
        setIsListening(false);
        setIsHolding(false);
      }),
      VoiceToText.addEventListener(VoiceToTextEvents.RESULTS, (event) => {
        setTranscript(event.value || '');
      }),
      VoiceToText.addEventListener(
        VoiceToTextEvents.PARTIAL_RESULTS,
        (event) => {
          setTranscript(event.value || '');
        }
      ),
      VoiceToText.addEventListener(VoiceToTextEvents.ERROR, (event) => {
        setIsListening(false);
        // Android 6 (speech timeout) / 7 (no match) and iOS 1110 (no speech
        // detected) mean the user said nothing. Not worth an alert.
        if ([6, 7, 1110].includes(event.code)) {
          console.log('No speech detected:', event);
          return;
        }
        console.error('Speech recognition error:', event);
        Alert.alert('Error', `${event.message} (code ${event.code})`);
      }),
    ];

    return () => {
      VoiceToText.destroy();
      subscriptions.forEach((subscription) => subscription.remove());
    };
  }, []);

  const ensurePermission = async () => {
    if (permissionGranted) return true;
    return requestMicrophonePermission();
  };

  const startRecognition = async () => {
    if (!(await ensurePermission())) return;
    setTranscript('');
    try {
      await VoiceToText.startListening();
    } catch (error) {
      console.error(error);
      Alert.alert('Error', 'Failed to start speech recognition');
    }
  };

  const stopRecognition = async () => {
    try {
      await VoiceToText.stopListening();
    } catch (error) {
      console.error(error);
    }
  };

  // Hold-to-talk: continuous mode keeps the recognizer alive across pauses
  // until the button is released, so a whole message arrives as one RESULTS.
  const startHoldToTalk = async () => {
    if (!(await ensurePermission())) return;
    setIsHolding(true);
    setTranscript('');
    try {
      await VoiceToText.startListening({ continuous: true });
    } catch (error) {
      setIsHolding(false);
      console.error(error);
      Alert.alert('Error', 'Failed to start speech recognition');
    }
  };

  const stopHoldToTalk = async () => {
    setIsHolding(false);
    try {
      await VoiceToText.stopListening();
    } catch (error) {
      console.error(error);
    }
  };

  // Applies to the next startListening(); a running session keeps its language.
  const changeLanguage = async (languageTag: string) => {
    setLanguagePickerOpen(false);
    if (languageTag === currentLanguage) return;
    try {
      await VoiceToText.setRecognitionLanguage(languageTag);
      setCurrentLanguage(languageTag);
    } catch (error: any) {
      console.error('Error setting language:', error);
      Alert.alert('Error', error?.message ?? 'Failed to change language');
    }
  };

  if (!initialized || !permissionGranted || !isAvailable) {
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar
          barStyle="dark-content"
          backgroundColor={colors.background}
        />
        <View style={styles.centered}>
          <Text style={styles.title}>Voice to Text</Text>
          <Text style={styles.message}>
            {!initialized
              ? 'Checking speech recognition…'
              : permissionGranted
                ? 'Speech recognition is not available on this device.'
                : 'Microphone access is required to transcribe speech.'}
          </Text>
          {initialized && !permissionGranted && (
            <Pressable
              style={({ pressed }) => [
                styles.primaryButton,
                pressed && styles.primaryButtonPressed,
              ]}
              onPress={requestMicrophonePermission}
            >
              <Text style={styles.primaryButtonText}>Grant permission</Text>
            </Pressable>
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Voice to Text</Text>
            <Text style={styles.subtitle}>Language: {currentLanguage}</Text>
          </View>
          <View
            style={[styles.statusPill, isListening && styles.statusPillActive]}
          >
            <View
              style={[styles.statusDot, isListening && styles.statusDotActive]}
            />
            <Text
              style={[
                styles.statusText,
                isListening && styles.statusTextActive,
              ]}
            >
              {isListening ? 'Listening' : 'Idle'}
            </Text>
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Transcript</Text>
            {transcript.length > 0 && !isListening && (
              <Pressable onPress={() => setTranscript('')} hitSlop={8}>
                <Text style={styles.link}>Clear</Text>
              </Pressable>
            )}
          </View>
          <Text style={[styles.transcript, !transcript && styles.placeholder]}>
            {transcript || 'Your words will appear here.'}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Controls</Text>

          <Pressable
            style={({ pressed }) => [
              styles.primaryButton,
              isListening && !isHolding && styles.stopButton,
              pressed && styles.primaryButtonPressed,
              isHolding && styles.buttonDisabled,
            ]}
            onPress={isListening ? stopRecognition : startRecognition}
            disabled={isHolding}
          >
            <Text style={styles.primaryButtonText}>
              {isListening && !isHolding ? 'Stop listening' : 'Start listening'}
            </Text>
          </Pressable>
          <Text style={styles.hint}>
            Single shot. Ends by itself after a short pause.
          </Text>

          {/* Push-to-talk: keeps listening for as long as the button is held,
              across pauses, and delivers everything said as one result. */}
          <Pressable
            style={({ pressed }) => [
              styles.holdButton,
              (pressed || isHolding) && styles.holdButtonActive,
              isListening && !isHolding && styles.buttonDisabled,
            ]}
            onPressIn={startHoldToTalk}
            onPressOut={stopHoldToTalk}
            disabled={isListening && !isHolding}
          >
            <Text style={styles.holdButtonText}>
              {isHolding ? 'Release to finish' : 'Hold to talk'}
            </Text>
          </Pressable>
          <Text style={styles.hint}>
            Continuous. Keeps listening across pauses until you let go.
          </Text>
        </View>

        <View style={styles.card}>
          <Pressable
            style={styles.cardHeader}
            onPress={() => setAdvancedOpen((open) => !open)}
            hitSlop={8}
          >
            <Text style={styles.cardTitle}>Advanced testing settings</Text>
            <Text style={styles.chevron}>{advancedOpen ? '▲' : '▼'}</Text>
          </Pressable>

          {advancedOpen && (
            <View style={styles.advancedBody}>
              <Text style={styles.fieldLabel}>Recognition language</Text>
              <Pressable
                style={({ pressed }) => [
                  styles.dropdown,
                  pressed && styles.dropdownPressed,
                  isListening && styles.buttonDisabled,
                ]}
                onPress={() => setLanguagePickerOpen(true)}
                disabled={isListening}
              >
                <Text style={styles.dropdownValue}>
                  {currentLanguage || 'Device default'}
                </Text>
                <Text style={styles.chevron}>▼</Text>
              </Pressable>
              <Text style={styles.hint}>
                Applies to the next session. {supportedLanguages.length}{' '}
                languages reported by the device.
              </Text>
            </View>
          )}
        </View>
      </ScrollView>

      <Modal
        visible={languagePickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setLanguagePickerOpen(false)}
      >
        <Pressable
          style={styles.backdrop}
          onPress={() => setLanguagePickerOpen(false)}
        >
          <Pressable style={styles.sheet} onPress={() => {}}>
            <Text style={styles.sheetTitle}>Recognition language</Text>
            <FlatList
              data={supportedLanguages}
              keyExtractor={(item) => item}
              style={styles.sheetList}
              initialNumToRender={20}
              renderItem={({ item }) => {
                const selected = item === currentLanguage;
                return (
                  <Pressable
                    style={({ pressed }) => [
                      styles.option,
                      pressed && styles.optionPressed,
                    ]}
                    onPress={() => changeLanguage(item)}
                  >
                    <Text
                      style={[
                        styles.optionText,
                        selected && styles.optionTextSelected,
                      ]}
                    >
                      {item}
                    </Text>
                    {selected && <Text style={styles.check}>✓</Text>}
                  </Pressable>
                );
              }}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
    // RN's SafeAreaView only insets on iOS; Android needs the status bar
    // height added by hand or content sits flush under it.
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0,
  },
  content: {
    padding: 20,
    paddingBottom: 40,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: colors.text,
  },
  subtitle: {
    marginTop: 4,
    fontSize: 14,
    color: colors.muted,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  statusPillActive: {
    borderColor: colors.danger,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
    backgroundColor: colors.muted,
  },
  statusDotActive: {
    backgroundColor: colors.danger,
  },
  statusText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.muted,
  },
  statusTextActive: {
    color: colors.danger,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 18,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
  },
  link: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.primary,
  },
  transcript: {
    marginTop: 12,
    minHeight: 72,
    fontSize: 18,
    lineHeight: 26,
    color: colors.text,
  },
  placeholder: {
    color: colors.muted,
  },
  primaryButton: {
    marginTop: 14,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: colors.primary,
  },
  primaryButtonPressed: {
    backgroundColor: colors.primaryPressed,
  },
  stopButton: {
    backgroundColor: colors.danger,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  holdButton: {
    marginTop: 18,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: colors.success,
  },
  holdButtonActive: {
    backgroundColor: colors.danger,
  },
  holdButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  hint: {
    marginTop: 8,
    fontSize: 13,
    lineHeight: 18,
    color: colors.muted,
  },
  message: {
    marginTop: 12,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    color: colors.muted,
  },
  chevron: {
    fontSize: 12,
    color: colors.muted,
  },
  advancedBody: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.muted,
    marginBottom: 8,
  },
  dropdown: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  dropdownPressed: {
    borderColor: colors.primary,
  },
  dropdownValue: {
    fontSize: 16,
    color: colors.text,
  },
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
  },
  sheet: {
    maxHeight: '60%',
    backgroundColor: colors.card,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 18,
    paddingBottom: 24,
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sheetList: {
    paddingHorizontal: 8,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  optionPressed: {
    backgroundColor: colors.background,
  },
  optionText: {
    fontSize: 16,
    color: colors.text,
  },
  optionTextSelected: {
    color: colors.primary,
    fontWeight: '600',
  },
  check: {
    fontSize: 16,
    color: colors.primary,
    fontWeight: '700',
  },
});

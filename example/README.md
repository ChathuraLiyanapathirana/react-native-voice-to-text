# Voice-to-Text Example App

This example demonstrates the usage of `react-native-voice-to-text` in a React Native application.

## Features Demonstrated

- Speech recognition with real-time feedback
- Language selection and switching
- Error handling and fallbacks
- Permission management

## Running the Example

This repository is a Yarn workspaces monorepo, so use Yarn (not npm) and run
commands from the repository root:

```sh
yarn
cd example/ios && pod install && cd ../..
yarn example start
yarn example android   # or: yarn example ios
```

The full walkthrough, including device selection, testing the legacy
architecture, and troubleshooting, is in [DEVELOPMENT.md](../DEVELOPMENT.md).

## Key Components

The example app demonstrates:

1. **Permission Handling**: Requesting and checking microphone permissions
2. **Speech Recognition**: Starting and stopping speech recognition
3. **Language Management**: Displaying and changing recognition languages
4. **Error Handling**: Handling common Android and iOS errors with user-friendly messages
5. **Fallbacks**: Using fallback language lists when native API fails

## Troubleshooting

If you encounter issues:

- Ensure microphone permissions are granted
- Check that speech recognition is available on your device
- For Android thread errors, update to the latest version of the package
- For iOS, ensure you've added the required entries to Info.plist

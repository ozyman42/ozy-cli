Set up any git repo to use a passkey-based SSH key. Auto registers SSH authn and signing keys with github.

Also can be used to auto provision npm packages and set up trusted publishing.

When ready update pipeline to include

- platform: darwin-arm64
            runner: macos-latest
          - platform: darwin-x64
            runner: macos-latest
          - platform: linux-x64
            runner: ubuntu-latest
          - platform: linux-arm64
            runner: ubuntu-24.04-arm
          - platform: windows-x64
            runner: windows-latest
          - platform: base-package
            runner: ubuntu-latest
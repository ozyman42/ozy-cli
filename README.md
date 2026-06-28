If you need to generate a new private ssh key run

`ssh-keygen -t ed25519 -C "your_email@example.com"`

then add the pubkey as both an AuthN and signing key at https://github.com/settings/keys



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
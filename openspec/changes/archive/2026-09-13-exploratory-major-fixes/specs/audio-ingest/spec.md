## ADDED Requirements

### Requirement: A container header the decoder cannot represent is the user's input

The Engine SHALL treat a container whose header declares values no decoder can work with (a WAV declaring a sample rate of 0) as unreadable input: the failure SHALL be one `error` event with the Error code `E_BAD_AUDIO` naming the file, and no runtime panic text SHALL reach stderr.

#### Scenario: Ira transcribes a WAV declaring sample rate 0

- GIVEN a WAV whose format chunk declares a sample rate of 0
- WHEN Ira runs `kesha broken.wav`
- THEN the Engine fails with `E_BAD_AUDIO` and a message naming `broken.wav`
- AND stderr carries that one event and nothing else
- AND the process exits 1

#### Scenario: A well-formed header still decodes

- GIVEN the same file re-exported with a real sample rate
- WHEN Ira runs `kesha fixed.wav`
- THEN it is decoded and transcribed as before

> *Technical Note — `rust/src/audio.rs::open_format` runs symphonia's probe under
> `rust/src/errors.rs::catch_panic`, which converts the panic into a coded
> `E_BAD_AUDIO` while the process-wide hook stays quiet for it.*

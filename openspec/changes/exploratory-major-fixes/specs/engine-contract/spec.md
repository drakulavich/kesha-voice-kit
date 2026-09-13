## ADDED Requirements

### Requirement: A panic is reported through the Event stream

The Engine SHALL report a panic it did not expect as one `error` event with the Error code `E_INTERNAL` naming the panic and its location, and SHALL then exit 1; the runtime's own panic prose and its `RUST_BACKTRACE` hint SHALL NOT reach stderr.

#### Scenario: An unexpected panic during a command

- GIVEN a command hits a panic no code path anticipated
- WHEN the Engine unwinds
- THEN stderr carries one `error` event whose `code` is `E_INTERNAL` and whose message starts with `engine panicked:`
- AND the process exits 1

#### Scenario: A panic the Engine anticipates and codes

- GIVEN a code path guards a known panic and reports it under its own Error code
- WHEN that panic fires
- THEN only the coded event is emitted, never a second `E_INTERNAL` for the same failure

> *Technical Note — `rust/src/errors.rs::install_panic_hook` is installed first thing in
> `rust/src/main.rs`, which also catches the unwind to exit 1; `catch_panic` marks the
> thread so the hook skips a panic the caller reports itself.*

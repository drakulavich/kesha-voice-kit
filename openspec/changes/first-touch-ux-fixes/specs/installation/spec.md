## ADDED Requirements

### Requirement: Install cost is stated before download
User-facing install documentation SHALL state the approximate download/disk cost of `kesha install` (~2.7 GB) and the quiet-progress behavior of the model step next to the command itself, and SHALL present `kesha install --plan` (exact sizes, downloads nothing) and `kesha status --disk` as the user-facing cost-inspection commands.

#### Scenario: reading Quick Start
- **WHEN** a new user reads the README Quick Start install step
- **THEN** the expected download size, disk footprint, and the `--plan` preview command are visible without leaving the section

### Requirement: Documented install entry points match interactive hints
Interactive missing-model errors recommend `kesha init`; the Quick Start SHALL mention `kesha init` and state its relationship to `kesha install` so the hint never names an undocumented command.

#### Scenario: user follows an interactive hint
- **WHEN** a TTY user sees "run `kesha init`" after a missing-model error and searches the README
- **THEN** the README explains what `kesha init` is and that it is interchangeable with `kesha install`

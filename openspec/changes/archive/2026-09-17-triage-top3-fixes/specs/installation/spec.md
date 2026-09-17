## ADDED Requirements

### Requirement: Concurrent installs into one Model cache are serialised, and a lock nobody holds is cleared

`kesha install` SHALL take a lock on the Engine directory before writing to it, so that two installs sharing one Model cache never overwrite each other, and SHALL wait for a live holder rather than fail. A lock whose owner is dead, whose owner has held it past the stale ceiling, or whose owner record does not parse SHALL be cleared by the next waiter within one poll interval rather than waited out; an owner record that cannot be read at all SHALL be treated as a live holder, since a permission or I/O failure says nothing about the install behind it. A waiter that outlasts the wait ceiling SHALL fail with `E_INSTALL_RACE`, naming the holder when it can and the lock path to delete in every case.

#### Scenario: Ira runs two installs at once against a shared cache

- GIVEN one `kesha install` holds the lock on a shared `KESHA_CACHE_DIR`
- WHEN Ira starts a second `kesha install` in another job
- THEN the second run reports that it is waiting and names the lock to delete if no install is running
- AND it proceeds as soon as the first run releases the lock

#### Scenario: The lock's owner record does not parse

- GIVEN the lock directory holds an owner file that is not valid JSON
- WHEN Maks runs `kesha install`
- THEN the install clears that lock on its first poll and proceeds
- AND it does not wait for the stale ceiling or report `E_INSTALL_RACE`

#### Scenario: The lock's owner record cannot be read

- GIVEN the lock directory holds an owner file the current user has no permission to read
- WHEN Ira runs `kesha install` with `KESHA_INSTALL_LOCK_WAIT_SECS` set
- THEN the install waits out that ceiling and fails with `E_INSTALL_RACE`
- AND the owner file is still there

#### Scenario: The lock directory holds something that is not an owner record

- GIVEN the lock directory holds a file that is not an owner record and no owner file
- WHEN Ira runs `kesha install` with `KESHA_INSTALL_LOCK_WAIT_SECS` set
- THEN the install waits out that ceiling and fails with `E_INSTALL_RACE`
- AND the message says the holder cannot be identified and names the lock path to delete

> *Technical Note — `src/install-lock.ts::acquireInstallLock` (#997) publishes an owner
> file inside a staged directory and renames it into place; `readOwner` returns the owner
> record, the owner file's token with no record when the file does not parse, the token
> marked `unreadable` when the file cannot be read, or null when there is no owner file; `clearLock` unlinks the owner by its exact name and then
> removes the directory. `waitTimedOut` is the `E_INSTALL_RACE` (#1018). Pinned by
> `tests/unit/install-lock.test.ts`.*

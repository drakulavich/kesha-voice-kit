# Release dogfood run

Run Kesha the way a user does before every stable tag. `just release-tag` refuses notes without a `## Dogfood` section in which every item below is ticked, so paste the checklist into `notes.md` and tick each item as it passes. An item that fails is a bug to fix before the tag, or an issue linked next to the item.

Use the release candidate from `main`, real voice notes from Telegram or WhatsApp (not synthesized speech, which only tests TTS), and listen to every reply yourself.

```markdown
## Dogfood

- [ ] First run: in an empty `KESHA_HOME`, `kesha voice.ogg` offers the install, and yes ends in a transcript.
- [ ] Russian voice note: `kesha ru.ogg` reads like what was said.
- [ ] English voice note: `kesha en.ogg` reads like what was said.
- [ ] Batch: `kesha --json ru.ogg en.ogg` gives each file its own correct `lang`.
- [ ] Long voice note: after `kesha install --vad`, a note over two minutes goes through VAD and stays in its language.
- [ ] Russian reply: `kesha say --format ogg-opus "…" > reply.ogg` with a number, a date, an abbreviation and a link plays in a messenger, every word spoken, nothing cut at the end.
- [ ] English reply: the same with an English sentence.
- [ ] Agent: Claude Code with `kesha mcp` (see `docs/mcp.md`) transcribes a voice note and speaks a reply without hints.
- [ ] `kesha --help` and one deliberate mistake (a missing file) read clearly.
```

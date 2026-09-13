//! Joining the chunks a long utterance is split into.
//!
//! Kokoro pads every utterance it synthesizes with near-silence at both edges
//! (~0.42 s lead, ~0.62 s tail on `am_michael`). Concatenating chunk samples
//! raw therefore stacks both paddings into ~1 s of dead air at each join —
//! 2.5x the median natural pause of the same clip, in a spot where the source
//! text had only a space (#808).

/// Silence a join may keep, split evenly between the two edges it trims.
/// Sized to the inter-word gaps an unchunked utterance shows (60–135 ms
/// measured on `en-am_michael`): the split consumed a space token, so the
/// join should read as a word boundary.
const SEAM_SILENCE_MS: usize = 120;

/// Analysis frame for the silence scan.
const FRAME_MS: usize = 5;

/// Frame RMS at or below this fraction of the chunk's loudest frame (-45 dB)
/// counts as silence. Kokoro's edge padding sits below -150 dB, so the value
/// only has to stay under real speech.
const SILENCE_FLOOR: f32 = 0.0056;

/// FluidAudio's Kokoro aborts a call whose acoustic frames pass 2000, and the
/// frames scale as characters divided by speed: 464 characters at `--rate 0.5`
/// reported `acousticFramesExceedCap(have: 2318, cap: 2000)`, i.e. 2.5 frames
/// per character at speed 1.0, and 404 characters reported 2.7 (T4-1).
const FLUID_FRAME_CAP: f32 = 2000.0;

/// Headroom under the cap: the estimate below is an average over text shapes.
const FLUID_FRAME_MARGIN: f32 = 0.9;

/// Frames one character costs at speed 1.0, rounded up from the 2.7 measured.
const FRAMES_PER_CHAR: f32 = 3.2;

/// Characters FluidAudio's Kokoro can render in one call at `speed`. The cap is
/// on output frames, so the slower the speech the less text fits.
pub fn fluid_chunk_budget(speed: f32) -> usize {
    let speed = if speed.is_finite() && speed > 0.0 {
        speed
    } else {
        1.0
    };
    (FLUID_FRAME_CAP * FLUID_FRAME_MARGIN * speed / FRAMES_PER_CHAR) as usize
}

/// Split `text` into chunks of at most `budget` characters, cutting at the last
/// sentence end that leaves a chunk at least half full, else the last such
/// clause end, else between words. A word longer than the budget is a chunk of
/// its own: nothing below a word is a place a listener would accept a seam.
pub fn chunk_text(text: &str, budget: usize) -> Vec<String> {
    let words: Vec<&str> = text.split_whitespace().collect();
    let budget = budget.max(1);
    let mut out = Vec::new();
    let (mut start, mut len, mut i) = (0usize, 0usize, 0usize);
    let mut sentence: Option<usize> = None;
    let mut clause: Option<usize> = None;
    while i < words.len() {
        let cost = words[i].chars().count() + usize::from(i > start);
        if i > start && len + cost > budget {
            let least = (i - start).div_ceil(2);
            let cut = sentence
                .filter(|&c| c - start >= least)
                .or(clause.filter(|&c| c - start >= least))
                .unwrap_or(i);
            out.push(words[start..cut].join(" "));
            (start, len, sentence, clause) = (cut, 0, None, None);
            for (j, word) in words[start..i].iter().enumerate() {
                len += word.chars().count() + usize::from(j > 0);
                match boundary(word) {
                    Boundary::Sentence => sentence = Some(start + j + 1),
                    Boundary::Clause => clause = Some(start + j + 1),
                    Boundary::None => {}
                }
            }
            continue;
        }
        len += cost;
        match boundary(words[i]) {
            Boundary::Sentence => sentence = Some(i + 1),
            Boundary::Clause => clause = Some(i + 1),
            Boundary::None => {}
        }
        i += 1;
    }
    if start < words.len() {
        out.push(words[start..].join(" "));
    }
    out
}

enum Boundary {
    Sentence,
    Clause,
    None,
}

/// Closing quotes and brackets sit outside the punctuation that ends the unit.
fn boundary(word: &str) -> Boundary {
    let last = word
        .chars()
        .rev()
        .find(|c| !matches!(c, '"' | '\'' | ')' | ']' | '}' | '»' | '”' | '’'));
    match last {
        Some('.' | '!' | '?' | '…' | '。' | '！' | '？') => Boundary::Sentence,
        Some(',' | ';' | ':' | '—' | '–' | '、') => Boundary::Clause,
        _ => Boundary::None,
    }
}

/// Concatenate the rendered chunks of one utterance, clipping the padding each
/// chunk carries at the joins back to [`SEAM_SILENCE_MS`]. The clip's own head
/// and tail keep the model's padding, and a single chunk is returned untouched.
pub fn join_chunks(chunks: Vec<Vec<f32>>, sample_rate: u32) -> Vec<f32> {
    let mut buf = SeamBuf::new(sample_rate);
    for chunk in chunks {
        buf.push_synth(chunk);
    }
    buf.finish()
}

/// One contribution to an utterance: samples an engine padded at both edges, or
/// the deliberate silence of a `<break>`.
enum Piece {
    Synth(Vec<f32>),
    Silence(usize),
}

/// Collects the pieces of one utterance so the padding stacked where two of
/// them meet is clipped once, when the utterance is complete. Deliberate
/// silence is never clipped: a `<break>` must last exactly as long as asked.
pub struct SeamBuf {
    pieces: Vec<Piece>,
    sample_rate: u32,
}

impl SeamBuf {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            pieces: Vec::new(),
            sample_rate,
        }
    }

    pub fn push_synth(&mut self, samples: Vec<f32>) {
        if !samples.is_empty() {
            self.pieces.push(Piece::Synth(samples));
        }
    }

    /// A zero-length silence is still a `<break>`: it asks for no pause at all
    /// where the engine's padding would otherwise leave one.
    pub fn push_silence(&mut self, samples: usize) {
        self.pieces.push(Piece::Silence(samples));
    }

    pub fn is_empty(&self) -> bool {
        self.pieces.iter().all(|p| matches!(p, Piece::Silence(0)))
    }

    pub fn finish(mut self) -> Vec<f32> {
        while matches!(self.pieces.first(), Some(Piece::Silence(0))) {
            self.pieces.remove(0);
        }
        while matches!(self.pieces.last(), Some(Piece::Silence(0))) {
            self.pieces.pop();
        }
        if self.pieces.len() < 2 {
            return match self.pieces.into_iter().next() {
                Some(Piece::Synth(samples)) => samples,
                Some(Piece::Silence(n)) => vec![0.0; n],
                None => Vec::new(),
            };
        }
        let frame = (self.sample_rate as usize * FRAME_MS / 1000).max(1);
        let keep = self.sample_rate as usize * SEAM_SILENCE_MS / 2000;
        let last = self.pieces.len() - 1;
        let mut out = Vec::new();
        for (i, piece) in self.pieces.iter().enumerate() {
            match piece {
                Piece::Silence(n) => out.extend(std::iter::repeat_n(0.0, *n)),
                Piece::Synth(samples) => {
                    let lead = (i > 0).then(|| neighbour_keep(&self.pieces[i - 1], keep));
                    let tail = (i < last).then(|| neighbour_keep(&self.pieces[i + 1], keep));
                    out.extend_from_slice(clip_edges(samples, frame, lead, tail))
                }
            }
        }
        out
    }
}

/// A deliberate silence is the whole pause the document asked for, so the edge
/// meeting it keeps none of its own padding; two synthesized runs split a word
/// boundary's worth between them.
fn neighbour_keep(neighbour: &Piece, keep: usize) -> usize {
    match neighbour {
        Piece::Silence(_) => 0,
        Piece::Synth(_) => keep,
    }
}

/// Narrow `samples` to the span that keeps at most `lead` / `tail` samples of
/// silence on that edge. `None` returns the edge in full.
fn clip_edges(samples: &[f32], frame: usize, lead: Option<usize>, tail: Option<usize>) -> &[f32] {
    let rms: Vec<f32> = samples
        .chunks(frame)
        .map(|f| (f.iter().map(|s| s * s).sum::<f32>() / f.len() as f32).sqrt())
        .collect();
    let floor = rms.iter().fold(0.0f32, |a, &b| a.max(b)) * SILENCE_FLOOR;
    let Some(first) = rms.iter().position(|&r| r > floor) else {
        let len = match lead.or(tail) {
            Some(keep) => keep.min(samples.len()),
            None => samples.len(),
        };
        return &samples[..len];
    };
    let voiced_end = rms.iter().rposition(|&r| r > floor).unwrap_or(first);
    let start = lead.map_or(0, |keep| (first * frame).saturating_sub(keep));
    let end = tail.map_or(samples.len(), |keep| {
        ((voiced_end + 1) * frame + keep).min(samples.len())
    });
    &samples[start..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 24_000;

    fn ms(n: usize) -> usize {
        SR as usize * n / 1000
    }

    /// Silence, then a tone, then silence — the shape Kokoro emits per chunk.
    fn padded(lead_ms: usize, tone_ms: usize, tail_ms: usize) -> Vec<f32> {
        let mut v = vec![0.0; ms(lead_ms)];
        v.extend((0..ms(tone_ms)).map(|i| if i % 24 < 12 { 0.5 } else { -0.5 }));
        v.extend(vec![0.0; ms(tail_ms)]);
        v
    }

    /// Longest run of samples under the audible floor, ignoring the head and
    /// tail of the clip — what a listener hears as a pause.
    fn longest_interior_silence(samples: &[f32]) -> usize {
        let voiced: Vec<usize> = samples
            .iter()
            .enumerate()
            .filter(|(_, s)| s.abs() > 0.01)
            .map(|(i, _)| i)
            .collect();
        voiced
            .windows(2)
            .map(|w| w[1] - w[0] - 1)
            .max()
            .unwrap_or(0)
    }

    #[test]
    fn join_clips_the_padding_stacked_at_a_seam() {
        let joined = join_chunks(vec![padded(400, 200, 600), padded(400, 200, 600)], SR);
        assert!(
            longest_interior_silence(&joined) <= ms(120),
            "seam kept {} ms of silence",
            longest_interior_silence(&joined) * 1000 / SR as usize
        );
    }

    #[test]
    fn join_keeps_the_clips_own_head_and_tail() {
        let joined = join_chunks(vec![padded(400, 200, 600), padded(400, 200, 600)], SR);
        let lead = joined.iter().take_while(|s| s.abs() <= 0.01).count();
        let tail = joined.iter().rev().take_while(|s| s.abs() <= 0.01).count();
        assert!(lead >= ms(390), "head padding lost: {lead} samples");
        assert!(tail >= ms(590), "tail padding lost: {tail} samples");
    }

    #[test]
    fn join_trims_both_edges_of_a_middle_chunk() {
        let joined = join_chunks(
            vec![
                padded(400, 200, 600),
                padded(400, 200, 600),
                padded(400, 200, 600),
            ],
            SR,
        );
        assert!(
            longest_interior_silence(&joined) <= ms(120),
            "seam kept {} samples of silence",
            longest_interior_silence(&joined)
        );
    }

    #[test]
    fn join_returns_a_single_chunk_verbatim() {
        let one = padded(400, 200, 600);
        assert_eq!(join_chunks(vec![one.clone()], SR), one);
        assert!(join_chunks(vec![], SR).is_empty());
    }

    #[test]
    fn join_leaves_a_gap_already_under_the_budget_alone() {
        let a = padded(400, 200, 20);
        let b = padded(20, 200, 600);
        let joined = join_chunks(vec![a.clone(), b.clone()], SR);
        assert_eq!(joined.len(), a.len() + b.len());
    }

    #[test]
    fn deliberate_silence_survives_the_join_at_its_full_length() {
        let mut buf = SeamBuf::new(SR);
        buf.push_synth(padded(400, 200, 600));
        buf.push_silence(ms(500));
        buf.push_synth(padded(400, 200, 600));
        let gap = longest_interior_silence(&buf.finish());
        assert!(
            (ms(500)..=ms(510)).contains(&gap),
            "a 500 ms break became {} ms of silence",
            gap * 1000 / SR as usize
        );
    }

    #[test]
    fn a_text_within_the_budget_is_one_chunk() {
        assert_eq!(
            chunk_text("one two three.", 40),
            vec!["one two three.".to_string()]
        );
        assert!(chunk_text("   ", 40).is_empty());
    }

    #[test]
    fn every_chunk_stays_within_the_budget_and_keeps_every_word() {
        let text = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
        for budget in [5, 12, 20, 31, 64] {
            let chunks = chunk_text(text, budget);
            assert_eq!(
                chunks.join(" "),
                text,
                "budget {budget} lost or reordered words"
            );
            for chunk in &chunks {
                let words = chunk.split_whitespace().count();
                assert!(
                    chunk.chars().count() <= budget || words == 1,
                    "budget {budget} produced a {}-char chunk of {words} words: {chunk}",
                    chunk.chars().count()
                );
            }
        }
    }

    #[test]
    fn a_sentence_end_is_preferred_to_a_clause_end_and_a_clause_end_to_a_space() {
        assert_eq!(
            chunk_text("one two. three, four five six seven", 20),
            vec![
                "one two.".to_string(),
                "three, four five six".to_string(),
                "seven".to_string()
            ]
        );
        assert_eq!(
            chunk_text("one two, three four five six", 20),
            vec!["one two,".to_string(), "three four five six".to_string()]
        );
        assert_eq!(
            chunk_text("onetwo three four five six", 14),
            vec!["onetwo three".to_string(), "four five six".to_string()]
        );
    }

    #[test]
    fn a_word_longer_than_the_budget_is_its_own_chunk() {
        assert_eq!(
            chunk_text("short aaaaaaaaaaaaaaaaaaaaaaaa short", 10),
            vec![
                "short".to_string(),
                "aaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
                "short".to_string()
            ]
        );
    }

    #[test]
    fn the_budget_shrinks_with_the_speech_rate() {
        let full = fluid_chunk_budget(1.0) as i64;
        assert!((2 * fluid_chunk_budget(0.5) as i64 - full).abs() <= 1);
        assert!((fluid_chunk_budget(2.0) as i64 - 2 * full).abs() <= 1);
        // 464 characters at 0.5 reported 2318 frames against a cap of 2000 (T4-1).
        assert!(
            fluid_chunk_budget(0.5) < 464,
            "the budget at half speed must refuse the text T4-1 measured"
        );
        assert!(fluid_chunk_budget(f32::NAN) > 0 && fluid_chunk_budget(0.0) > 0);
    }

    #[test]
    fn a_zero_length_break_leaves_no_pause_at_all() {
        let mut buf = SeamBuf::new(SR);
        buf.push_synth(padded(400, 200, 600));
        buf.push_silence(0);
        buf.push_synth(padded(400, 200, 600));
        let gap = longest_interior_silence(&buf.finish());
        assert!(
            gap <= ms(10),
            "a 0 ms break left {} ms of silence",
            gap * 1000 / SR as usize
        );
    }

    #[test]
    fn a_document_of_only_zero_length_breaks_has_no_audio() {
        let mut buf = SeamBuf::new(SR);
        buf.push_silence(0);
        assert!(buf.is_empty(), "a 0 ms break alone is not audio");
        assert!(buf.finish().is_empty());
    }

    #[test]
    fn a_lone_silence_is_returned_whole() {
        let mut buf = SeamBuf::new(SR);
        buf.push_silence(ms(250));
        assert_eq!(buf.finish().len(), ms(250));
    }

    #[test]
    fn empty_pieces_are_not_joins() {
        let mut buf = SeamBuf::new(SR);
        let one = padded(400, 200, 600);
        buf.push_synth(Vec::new());
        buf.push_synth(one.clone());
        buf.push_silence(0);
        assert_eq!(
            buf.finish(),
            one,
            "an empty piece must not clip its neighbour"
        );
    }

    #[test]
    fn join_bounds_an_all_silent_chunk() {
        let joined = join_chunks(
            vec![
                padded(400, 200, 600),
                vec![0.0; ms(2000)],
                padded(400, 200, 600),
            ],
            SR,
        );
        assert!(
            longest_interior_silence(&joined) <= ms(180),
            "all-silent chunk contributed {} samples",
            longest_interior_silence(&joined)
        );
    }
}

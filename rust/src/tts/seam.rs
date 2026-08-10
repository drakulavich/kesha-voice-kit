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

/// Concatenate the rendered chunks of one utterance, clipping the padding each
/// chunk carries at the joins back to [`SEAM_SILENCE_MS`]. The clip's own head
/// and tail keep the model's padding, and a single chunk is returned untouched.
pub fn join_chunks(chunks: Vec<Vec<f32>>, sample_rate: u32) -> Vec<f32> {
    if chunks.len() < 2 {
        return chunks.into_iter().next().unwrap_or_default();
    }
    let frame = (sample_rate as usize * FRAME_MS / 1000).max(1);
    let keep = sample_rate as usize * SEAM_SILENCE_MS / 2000;
    let last = chunks.len() - 1;
    let mut out = Vec::new();
    for (i, chunk) in chunks.iter().enumerate() {
        out.extend_from_slice(clip_edges(chunk, frame, keep, i > 0, i < last));
    }
    out
}

/// Narrow `samples` to the span that keeps at most `keep` samples of silence
/// on each requested edge. An edge not requested is returned in full.
fn clip_edges(samples: &[f32], frame: usize, keep: usize, lead: bool, tail: bool) -> &[f32] {
    let rms: Vec<f32> = samples
        .chunks(frame)
        .map(|f| (f.iter().map(|s| s * s).sum::<f32>() / f.len() as f32).sqrt())
        .collect();
    let floor = rms.iter().fold(0.0f32, |a, &b| a.max(b)) * SILENCE_FLOOR;
    let Some(first) = rms.iter().position(|&r| r > floor) else {
        let len = if lead || tail {
            keep.min(samples.len())
        } else {
            samples.len()
        };
        return &samples[..len];
    };
    let voiced_end = rms.iter().rposition(|&r| r > floor).unwrap_or(first);
    let start = if lead {
        (first * frame).saturating_sub(keep)
    } else {
        0
    };
    let end = if tail {
        ((voiced_end + 1) * frame + keep).min(samples.len())
    } else {
        samples.len()
    };
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

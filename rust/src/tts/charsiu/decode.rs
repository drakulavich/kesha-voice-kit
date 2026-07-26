//! KV-cache autoregressive greedy decode over the three CharsiuG2P sessions.
//!
//! Threading (IO contract #185 §3, byt5-tiny config: 4 layers, 6 heads, d_kv=64):
//!
//! - **Step 0** runs `decoder_model` with `decoder_start_token_id` (0) and the
//!   encoder outputs. It emits 16 present tensors:
//!   `present.{0..3}.{decoder,encoder}.{key,value}`. We seed the 8 encoder K/V
//!   (constant for the whole decode) and the 8 decoder K/V (which grow each step).
//! - **Steps 1..MAX** run `decoder_with_past_model` with the single last token,
//!   the 8 constant encoder K/V re-fed verbatim, and the 8 rolling decoder K/V.
//!   It emits ONLY 8 decoder presents (`present.{0..3}.decoder.{key,value}`),
//!   each one row longer; we adopt them as the next step's decoder past.
//!
//! Stops on EOS (1) or after [`MAX_STEPS`]. Returns generated ids (start token
//! excluded), EOS excluded.

use anyhow::Result;
use ndarray::{Array2, Array3, Array4};
use ort::session::Session;
use ort::value::Value;

use super::tokenizer::EOS_ID;

/// byt5-tiny decoder start token id (#185 §3).
const DECODER_START_TOKEN_ID: i64 = 0;
/// Number of decoder layers in byt5-tiny (#185 §3).
const NUM_LAYERS: usize = 4;
/// Hard cap on generated tokens. IPA words are short; this guards a runaway decode.
const MAX_STEPS: usize = 128;

struct LayerKv {
    key: Array4<f32>,
    value: Array4<f32>,
}

/// Greedy-decode `input_ids` (already tag-prefixed + EOS-terminated) to output token ids.
pub fn greedy(
    encoder: &mut Session,
    decoder: &mut Session,
    decoder_past: &mut Session,
    input_ids: &[i64],
) -> Result<Vec<i64>> {
    anyhow::ensure!(!input_ids.is_empty(), "input_ids must be non-empty");
    let s_enc = input_ids.len();

    let enc_ids = Value::from_array(Array2::<i64>::from_shape_vec(
        (1, s_enc),
        input_ids.to_vec(),
    )?)?;
    let enc_mask_vec = vec![1_i64; s_enc];
    let enc_mask = Value::from_array(Array2::<i64>::from_shape_vec(
        (1, s_enc),
        enc_mask_vec.clone(),
    )?)?;
    let enc_out = encoder.run(ort::inputs![
        "input_ids" => enc_ids,
        "attention_mask" => enc_mask,
    ])?;
    let (eh_shape, eh_data) = enc_out["last_hidden_state"].try_extract_tensor::<f32>()?;
    let d_model = eh_shape[2] as usize;
    let encoder_hidden = Array3::<f32>::from_shape_vec((1, s_enc, d_model), eh_data.to_vec())?;

    let start = Array2::<i64>::from_shape_vec((1, 1), vec![DECODER_START_TOKEN_ID])?;
    let step0_out = decoder.run(ort::inputs![
        "input_ids" => Value::from_array(start)?,
        "encoder_attention_mask" => Value::from_array(Array2::<i64>::from_shape_vec((1, s_enc), enc_mask_vec.clone())?)?,
        "encoder_hidden_states" => Value::from_array(encoder_hidden)?,
    ])?;

    let mut generated: Vec<i64> = Vec::new();
    let next = argmax_last_logit(&step0_out["logits"])?;
    if next == EOS_ID {
        return Ok(generated);
    }
    generated.push(next);

    let mut encoder_kv: Vec<LayerKv> = Vec::with_capacity(NUM_LAYERS);
    let mut decoder_kv: Vec<LayerKv> = Vec::with_capacity(NUM_LAYERS);
    for layer in 0..NUM_LAYERS {
        encoder_kv.push(LayerKv {
            key: extract_kv(&step0_out, &kv_name("present", layer, "encoder", "key"))?,
            value: extract_kv(&step0_out, &kv_name("present", layer, "encoder", "value"))?,
        });
        decoder_kv.push(LayerKv {
            key: extract_kv(&step0_out, &kv_name("present", layer, "decoder", "key"))?,
            value: extract_kv(&step0_out, &kv_name("present", layer, "decoder", "value"))?,
        });
    }
    drop(step0_out);

    let mut last_token = next;
    let mut hit_eos = false;
    for _ in 1..MAX_STEPS {
        let mut inputs = ort::inputs![
            "input_ids" => Value::from_array(Array2::<i64>::from_shape_vec((1, 1), vec![last_token])?)?,
            "encoder_attention_mask" => Value::from_array(Array2::<i64>::from_shape_vec((1, s_enc), enc_mask_vec.clone())?)?,
        ];
        // 16 past_key_values: 8 constant encoder + 8 rolling decoder.
        for (layer, (dec, enc)) in decoder_kv.iter().zip(encoder_kv.iter()).enumerate() {
            inputs.push((
                kv_name("past_key_values", layer, "decoder", "key").into(),
                Value::from_array(dec.key.clone())?.into(),
            ));
            inputs.push((
                kv_name("past_key_values", layer, "decoder", "value").into(),
                Value::from_array(dec.value.clone())?.into(),
            ));
            inputs.push((
                kv_name("past_key_values", layer, "encoder", "key").into(),
                Value::from_array(enc.key.clone())?.into(),
            ));
            inputs.push((
                kv_name("past_key_values", layer, "encoder", "value").into(),
                Value::from_array(enc.value.clone())?.into(),
            ));
        }

        let out = decoder_past.run(inputs)?;
        let next = argmax_last_logit(&out["logits"])?;
        if next == EOS_ID {
            hit_eos = true;
            break;
        }
        generated.push(next);
        last_token = next;

        for (layer, kv) in decoder_kv.iter_mut().enumerate() {
            kv.key = extract_kv(&out, &kv_name("present", layer, "decoder", "key"))?;
            kv.value = extract_kv(&out, &kv_name("present", layer, "decoder", "value"))?;
        }
    }

    if !hit_eos {
        // Loop exhausted the cap without an EOS — the IPA is truncated, which
        // surfaces as a clipped/mispronounced tail rather than an error. One
        // boundary trace (lazy, #313) so it's diagnosable; not per-token.
        crate::dtrace!(
            "charsiu::decode hit MAX_STEPS={MAX_STEPS} without EOS; IPA may be truncated"
        );
    }
    Ok(generated)
}

// ── Pure helpers (no Session access) ────────────────────────────────────────

/// `{prefix}.{layer}.{side}.{kind}` — the #185 §3 KV tensor naming contract
/// shared by `present.*` outputs and `past_key_values.*` inputs.
fn kv_name(prefix: &str, layer: usize, side: &str, kind: &str) -> String {
    format!("{prefix}.{layer}.{side}.{kind}")
}

/// Argmax over the vocab axis of the last decode position. `shape` is
/// [B, S, V]; ties pick the lowest index (mirrors `util::argmax`).
fn argmax_last_row(shape: &[usize], data: &[f32]) -> Result<i64> {
    anyhow::ensure!(
        shape.len() == 3,
        "expected logits rank 3 [B,S,V], got shape {shape:?}"
    );
    let (s, v) = (shape[1], shape[2]);
    anyhow::ensure!(s >= 1 && v >= 1, "empty logits, shape {shape:?}");
    anyhow::ensure!(
        data.len() >= s * v,
        "logits data has {} values, shape {shape:?} implies at least {}",
        data.len(),
        s * v
    );
    let row = &data[(s - 1) * v..s * v];
    let mut best = 0_usize;
    let mut best_val = row[0];
    for (i, &val) in row.iter().enumerate().skip(1) {
        if val > best_val {
            best_val = val;
            best = i;
        }
    }
    Ok(best as i64)
}

/// Validate a KV tensor shape [B, num_heads, seq, d_kv].
fn kv_dims(name: &str, shape: &[usize]) -> Result<(usize, usize, usize, usize)> {
    anyhow::ensure!(
        shape.len() == 4,
        "expected KV rank 4 for {name}, got shape {shape:?}"
    );
    Ok((shape[0], shape[1], shape[2], shape[3]))
}

/// Argmax over the vocab axis of the last decode position. Logits shape [1, S, V].
fn argmax_last_logit(logits: &Value) -> Result<i64> {
    let (shape, data) = logits.try_extract_tensor::<f32>()?;
    let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    argmax_last_row(&dims, data)
}

/// Extract a 4-D KV tensor [B, num_heads, seq, d_kv] from a named output.
fn extract_kv(outputs: &ort::session::SessionOutputs, name: &str) -> Result<Array4<f32>> {
    let (shape, data) = outputs[name].try_extract_tensor::<f32>()?;
    let dims_vec: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    let dims = kv_dims(name, &dims_vec)?;
    Ok(Array4::<f32>::from_shape_vec(dims, data.to_vec())?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kv_names_match_the_185_contract() {
        let mut past = Vec::new();
        let mut present = Vec::new();
        for layer in 0..NUM_LAYERS {
            for side in ["decoder", "encoder"] {
                for kind in ["key", "value"] {
                    past.push(kv_name("past_key_values", layer, side, kind));
                    present.push(kv_name("present", layer, side, kind));
                }
            }
        }
        assert_eq!(past.len(), 16);
        assert_eq!(past[0], "past_key_values.0.decoder.key");
        assert_eq!(present[15], "present.3.encoder.value");
        let unique: std::collections::HashSet<_> = past.iter().chain(present.iter()).collect();
        assert_eq!(unique.len(), 32, "names must not collide");
    }

    #[test]
    fn argmax_last_row_picks_last_position_and_low_tie() {
        // Two positions; only the last row must be scanned.
        let data = [9.0_f32, 0.0, 0.0, /* last row: */ 1.0, 5.0, 5.0];
        assert_eq!(
            argmax_last_row(&[1, 2, 3], &data).unwrap(),
            1,
            "tie → lowest index"
        );
    }

    #[test]
    fn argmax_last_row_rejects_bad_shapes() {
        assert!(argmax_last_row(&[1, 2], &[0.0]).is_err(), "rank 2");
        assert!(argmax_last_row(&[1, 0, 3], &[]).is_err(), "empty seq");
        let err = argmax_last_row(&[1, 1, 4], &[0.0; 2]).unwrap_err();
        assert!(err.to_string().contains("implies at least"), "{err}");
    }

    #[test]
    fn kv_dims_requires_rank_4() {
        assert_eq!(kv_dims("t", &[1, 6, 3, 64]).unwrap(), (1, 6, 3, 64));
        let err = kv_dims("present.0.decoder.key", &[1, 6, 3]).unwrap_err();
        assert!(err.to_string().contains("rank 4"), "{err}");
    }
}

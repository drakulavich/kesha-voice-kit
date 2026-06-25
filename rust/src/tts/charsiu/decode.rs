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
            key: extract_kv(&step0_out, &format!("present.{layer}.encoder.key"))?,
            value: extract_kv(&step0_out, &format!("present.{layer}.encoder.value"))?,
        });
        decoder_kv.push(LayerKv {
            key: extract_kv(&step0_out, &format!("present.{layer}.decoder.key"))?,
            value: extract_kv(&step0_out, &format!("present.{layer}.decoder.value"))?,
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
                format!("past_key_values.{layer}.decoder.key").into(),
                Value::from_array(dec.key.clone())?.into(),
            ));
            inputs.push((
                format!("past_key_values.{layer}.decoder.value").into(),
                Value::from_array(dec.value.clone())?.into(),
            ));
            inputs.push((
                format!("past_key_values.{layer}.encoder.key").into(),
                Value::from_array(enc.key.clone())?.into(),
            ));
            inputs.push((
                format!("past_key_values.{layer}.encoder.value").into(),
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
            kv.key = extract_kv(&out, &format!("present.{layer}.decoder.key"))?;
            kv.value = extract_kv(&out, &format!("present.{layer}.decoder.value"))?;
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

/// Argmax over the vocab axis of the last decode position. Logits shape [1, S, V].
fn argmax_last_logit(logits: &Value) -> Result<i64> {
    let (shape, data) = logits.try_extract_tensor::<f32>()?;
    anyhow::ensure!(
        shape.len() == 3,
        "expected logits rank 3 [B,S,V], got shape {shape:?}"
    );
    let s = shape[1] as usize;
    let v = shape[2] as usize;
    anyhow::ensure!(s >= 1 && v >= 1, "empty logits, shape {shape:?}");
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

/// Extract a 4-D KV tensor [B, num_heads, seq, d_kv] from a named output.
fn extract_kv(outputs: &ort::session::SessionOutputs, name: &str) -> Result<Array4<f32>> {
    let (shape, data) = outputs[name].try_extract_tensor::<f32>()?;
    anyhow::ensure!(
        shape.len() == 4,
        "expected KV rank 4 for {name}, got shape {shape:?}"
    );
    let dims = (
        shape[0] as usize,
        shape[1] as usize,
        shape[2] as usize,
        shape[3] as usize,
    );
    Ok(Array4::<f32>::from_shape_vec(dims, data.to_vec())?)
}

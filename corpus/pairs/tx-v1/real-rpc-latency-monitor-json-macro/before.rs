// Excerpt, unmodified, of src/rpc/methods.rs (lines 341-357)
// from https://github.com/solana-foundation/rpc-latency-monitor at commit cca0a575c155 — before pull request #86.
// Licensed under Apache-2.0 by its authors; see corpus/pairs/NOTICE.md.

fn transaction_params(signature: String) -> Value {
    json!([signature, {
        "encoding": "json",
        "commitment": "confirmed",
        "maxSupportedTransactionVersion": 0,
    }])
}

fn block_params(slot: u64) -> Value {
    json!([slot, {
        "encoding": "json",
        "transactionDetails": "full",
        "rewards": false,
        "commitment": "confirmed",
        "maxSupportedTransactionVersion": 0,
    }])
}

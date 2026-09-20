// Excerpt, unmodified, of indexer/src/indexer/datasource/rpc_polling/rpc.rs (lines 52-68)
// from https://github.com/solana-foundation/solana-private-channels at commit 46a8e243df3b — before pull request #303.
// Licensed under MIT by its authors; see corpus/pairs/NOTICE.md.

            .json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getBlock",
                "params": [
                    slot,
                    {
                        "encoding": self.encoding.to_string(),
                        "transactionDetails": "full",
                        "maxSupportedTransactionVersion": 0,
                        "rewards": false,
                        "commitment": self.commitment.to_string(),
                    }
                ]
            }))
            .send()
            .await?;

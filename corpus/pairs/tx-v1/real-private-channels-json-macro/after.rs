// Excerpt, unmodified, of indexer/src/indexer/datasource/rpc_polling/rpc.rs (lines 57-73)
// from https://github.com/solana-foundation/solana-private-channels at commit a9802b18e86f — after pull request #303.
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
                        "maxSupportedTransactionVersion": MAX_SUPPORTED_TRANSACTION_VERSION,
                        "rewards": false,
                        "commitment": self.commitment.to_string(),
                    }
                ]
            }))
            .send()
            .await?;

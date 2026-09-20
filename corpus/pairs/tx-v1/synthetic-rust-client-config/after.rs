// Written for the corpus after the shape of real fixes that could not be copied: sig-net/mpc#1215 is under
// AGPL-3.0. The Rust RPC client takes the version as an Option in its config struct.
let config = RpcBlockConfig {
    encoding: Some(UiTransactionEncoding::Base64),
    transaction_details: Some(TransactionDetails::Full),
    rewards: Some(false),
    commitment: Some(CommitmentConfig::finalized()),
    max_supported_transaction_version: Some(1),
};

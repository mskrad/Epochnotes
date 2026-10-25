// Written for the corpus: the age is the difference of the block times of both slots.
use solana_client::rpc_client::RpcClient;

pub fn age_in_seconds(
    client: &RpcClient,
    current_slot: u64,
    observed_slot: u64,
) -> Result<i64, Box<dyn std::error::Error>> {
    let now = client.get_block_time(current_slot)?;
    let then = client.get_block_time(observed_slot)?;
    Ok(now - then)
}

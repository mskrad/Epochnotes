// Written for the corpus after calls seen in the field (viem and ethers clients inside multi-chain projects):
// the same method names, another chain. None of this is a Solana read.
const receipt = await publicClient.getTransaction({ hash });
const latest = await provider.getBlock('finalized');
const pending = await provider.getBlock("pending");
const tagged = await client.getBlock(`0x${height.toString(16)}`);
const head = await rpc.getBlock();

// Written for the corpus: the value comes from a variable, so only a person can tell whether it is high enough.
const version = Number(process.env.MAX_TX_VERSION ?? 0);
export const read = (connection: Connection, signature: string) =>
  connection.getTransaction(signature, { maxSupportedTransactionVersion: version });

// Written for the corpus: the value comes from a variable, so only a person can tell whether it is high enough.
export const read = (connection: Connection, signature: string) =>
  connection.getTransaction(signature, { maxSupportedTransactionVersion: 1 });

# Written for the corpus: the Python client takes the version as a keyword argument. No public fix of this
# shape was found that could be copied.
response = client.get_transaction(
    signature,
    encoding="jsonParsed",
    max_supported_transaction_version=1,
)

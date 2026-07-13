# Fixtures — provenance matters

Every file here is tagged in its name:
- `docs.*` — reconstructed from Paystack's published documentation. Good enough
  for structure; NOT proof of production behavior. Connector stays EXPERIMENTAL
  while these dominate.
- `prod.*` — sanitized real payloads (scrubbed via the fixture scrubber; CI
  rejects unsanitized PII). These are what graduate a connector to "supported".

Never edit a prod fixture by hand. Byte fidelity is the entire point.

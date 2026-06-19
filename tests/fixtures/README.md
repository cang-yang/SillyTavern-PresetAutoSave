# Test fixtures

`openai-settings-contract.json` locks the preset/connection field split from
SillyTavern 1.18.0 `public/scripts/openai.js` (`settingsToUpdate`). It contains
field names only and no user data or credentials.

`chat-completion-structure.json` contains only the field shapes observed in the repository's `梦境思客V2-0429.json` preset. Prompt text, model/provider configuration, URLs, headers, credentials and other connection data are intentionally absent.

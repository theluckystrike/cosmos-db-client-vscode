# Connect without an Azure sign-in

Local emulator, one click. Start the Cosmos DB emulator (Windows installer, or Docker on macOS and Linux):

```
docker run -d -p 8081:8081 -p 1234:1234 mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:vnext-preview
```

Then click Connect to Local Emulator. The extension tries https and http on `localhost:8081` with the emulator's public key. The emulator's self-signed certificate is accepted for `localhost` only.

Azure account. In the Azure portal open your Cosmos DB account, then Keys, and copy the primary connection string (`AccountEndpoint=...;AccountKey=...;`). Choose Add Connection, then Connection string and paste it. The key goes to VS Code's secret storage, not to settings.

Microsoft Entra ID. For accounts without keys, choose Microsoft Entra ID. VS Code's built-in Microsoft sign-in is used, and your account needs a Cosmos DB data role.

The extension talks only to the endpoints you add. No telemetry.

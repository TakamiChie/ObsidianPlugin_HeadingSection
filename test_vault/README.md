# テスト Vault

Obsidian の「保管庫としてフォルダーを開く」から、この `test_vault` フォルダーを指定してください。

1. リポジトリのルートで `npm run build` を実行します。
2. Obsidian でこの Vault を開き、コミュニティプラグインの制限モードを解除します。
3. **Heading Section Tools** が有効であることを確認します。
4. `見出し操作テスト.md` を Live Preview で開いて確認します。

ビルド時に `main.js` と `manifest.json` が、この Vault のプラグインフォルダーへ自動的に同期されます。コード変更後は再ビルドし、Obsidian の「プラグインを再読み込み」または開発者ツールのリロードを行ってください。

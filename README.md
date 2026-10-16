# ChulipVideo-Web

動画を端末内で切り出し・クロップし、MP4・GIF・PNGへ保存するブラウザ版の動画編集ツールです。動画や操作履歴をサーバーへアップロードせず、FFmpeg WebAssemblyで処理します。

[公開版を使う](https://excel-chunchun.sakura.ne.jp/test/chulip-video/) · [詳しい利用方法](docs/WEB_BROWSER.md)

## 主な機能

- 再生、シーク、速度変更、区間再生、ループ、トリミング
- ドラッグと数値入力によるクロップ、Undo/Redo、解像度プリセット
- MOV・MKV・HEVCの再生用MP4を端末内で自動生成
- 操作TSVのマウスポインター・クリック・キー字幕の合成
- MP4、GIF、PNG連番ZIP、現在位置のPNG、クリップボードへの画像出力
- PC・スマートフォンの5タブ表示と、タッチ操作できるタイムライン
- ブラウザ内への編集設定保存

入力動画に固定の容量制限はありません。実際に処理できる容量は端末・ブラウザのメモリー等に依存します。単一出力は512MiB、PNG連番は1,000枚・展開画素合計512MiBまでです。録画・映像キャプチャ画面は含みません。

## ローカル起動

Node.js 22系とnpmを用意し、次を実行してください。

```sh
git clone https://github.com/KotorinChunChun/ChulipVideo-Web.git
cd ChulipVideo-Web
npm ci
npm run dev
```

`http://127.0.0.1:1421` を開きます。利用者が動画を選択した後も、素材は端末内に留まります。動画処理エンジンとフォントは同じ配信元から読み込みます。

## ビルド・静的配信

```sh
npm run test:web
npm run build
npm run preview
```

`dist-web/` の内容をHTTP/HTTPSで配信してください。`npm run build` でFFmpegの配信用ファイルも準備します。サーバーは `.wasm` を `application/wasm` で返す設定にしてください。専用の動画処理サーバーやRustのインストールは不要です。

## ブラウザ検証

単体テストは `npm run test:web`。実ブラウザ検証には、別途Playwright、Chromeと、合成素材の生成・出力確認に使用するネイティブFFmpegが必要です。FFmpegの場所は `CHULIP_TEST_FFMPEG`、対象URLは `CHULIP_WEB_URL` で指定できます。

```sh
node scripts/browser.test.mjs
node scripts/iphone-browser.test.mjs
node scripts/mobile-browser.test.mjs
node scripts/mkv-browser.test.mjs
```

検証素材・ログ・録画は `dev/history/v0.3.0/logs/` 以下に生成され、Git対象外です。513MiB検証素材は短い合成動画にパディングを加えたもので、長時間4K動画の限界試験ではありません。iPhone Safari実機・HDR/Dolby Visionの色再現は未検証です。

## ソースについて

ChulipVideo Rust/Tauri版の共有フロントエンドから、公開中のWeb版に必要なソースを抽出した独立リポジトリです。共有UIにはTauri APIへの参照が残っていますが、Web版ではブラウザ用APIを使用します。Rustバックエンドは含みません。[作成・検証記録](dev/history/v0.3.0/v0.3.0-imp.md)

## ライセンス

本アプリのソースは [MIT License](LICENSE) です。FFmpeg coreはGPL-2.0-or-later、Noto Sans JPはSIL Open Font License 1.1など、同梱依存にはそれぞれのライセンスが適用されます。[依存ソフトウェアとライセンス](public/THIRD_PARTY_NOTICES.txt)

# 仮想CPU ラボ

小さな仮想 CPU「TOY」を動かしながら、コンピュータアーキテクチャ (パイプライン・キャッシュ・記憶階層・マルチコア) を学ぶための教材と、その土台になるシミュレータです。ブラウザだけで動き、ビルドも依存パッケージもいりません。

## ラボ

| ラボ | 学べること |
|---|---|
| [命令セット・ラボ](labs/playground/) | 命令セットと機械語。プログラムを書いて 1 命令ずつ実行する |
| [パイプライン・ラボ](labs/pipeline/) | 5 段パイプライン、データハザード、フォワーディング、分岐の取り消し |
| [スループット・ラボ](labs/throughput/) | IPC・CPI・MIPS、分岐予測、スーパースカラ |
| [キャッシュ・ラボ](labs/cache/) | 連想度、置換方式、ライトバック/ライトスルー、3C |
| [レイテンシ・ラボ](labs/latency/) | 記憶階層、ワーキングセット、ILP、メモリレベル並列性 |
| [アトミック・ラボ](labs/atomic/) | 競合状態、CAS、スピンロック、LL/SC |

すべてのラボが同じ命令セット (TOY) と同じシミュレータ (`core/`) を使っています。

## ドキュメント

| ドキュメント | 内容 |
|---|---|
| [はじめに](docs/overview.md) | 全体の構成と用語 |
| [学習カリキュラム](docs/curriculum.md) | 6 つの単元、目標と確認問題 |
| [命令セット仕様](docs/isa.md) | TOY ISA 1.0 (レジスタ、命令形式、全命令、例外) |
| [アセンブリ言語](docs/assembly.md) | 書き方、疑似命令、アセンブラ指令 |
| [実行モデル](docs/machine.md) | 機能シミュレータ、実行記録、マルチコア |
| [タイミングモデル](docs/timing.md) | パイプライン、キャッシュ、記憶階層、分岐予測の規則と基準構成 |
| [拡張ガイド](docs/extending.md) | 命令・モデル・ポート・ラボ・教材の足し方 |
| [API リファレンス](docs/api.md) | `core/` の JavaScript API |
| [用語集](docs/glossary.md) | ラボ・教材・技術用語の呼び方 |

公開したサイトでは `/docs/` で読めます。命令の一覧表は `/reference/` にあり、コードから自動で作られます。

## 使ってみる (JavaScript)

```js
import { defaultISA, assemble, Machine, PipelineModel } from './core/index.js';

const { program, errors } = assemble(`
        LI   r1, 10
loop:   ADD  r2, r2, r1
        SUBI r1, r1, 1
        BNEZ r1, loop
`, { isa: defaultISA() });

const { trace } = new Machine({ program }).trace();   // 何が起きるか
const pipe = new PipelineModel({ forwarding: true });  // いつ起きるか
trace.forEach(r => pipe.push(r));
console.log(pipe.finish().cycles);
```

## 手元で動かす

```sh
python3 -m http.server 8000      # → http://localhost:8000/
node --test tests/*.test.js      # テスト (Node 18 以上)
```

ES モジュールを使っているので、`index.html` をファイルとして直接開くと動きません。サーバー経由で開いてください。

## GitHub Pages で公開する

1. このリポジトリを GitHub に push する
2. **Settings → Pages** で Source を「Deploy from a branch」、Branch を `main` / `(root)` にする
3. 1〜2 分後に `https://<ユーザー名>.github.io/<リポジトリ名>/` で開ける

## 貢献

[CONTRIBUTING.md](CONTRIBUTING.md) を見てください。

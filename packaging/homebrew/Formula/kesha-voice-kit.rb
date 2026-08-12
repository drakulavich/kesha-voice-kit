class KeshaVoiceKit < Formula
  desc "Local speech-to-text, text-to-speech, and language detection toolkit"
  homepage "https://github.com/drakulavich/kesha-voice-kit"
  # Release rewrites this pin, but ci.yml's homebrew-formula lane builds it — it must carry every path install stages.
  url "https://github.com/drakulavich/kesha-voice-kit/archive/refs/tags/v1.24.7.tar.gz"
  sha256 "92531aaad3537b8e27322f425d8af9fa3fc8cb9592796893155c6bed0ef90b67"
  license "MIT"

  depends_on "oven-sh/bun/bun"

  def install
    libexec.install "bin", "src", "completions", "man", "package.json", "bun.lock", "tsconfig.json"
    libexec.install "openclaw.plugin.json", "openclaw-plugin.cjs"
    libexec.install "LICENSE", "NOTICES.md", "README.md"

    cd libexec do
      system "bun", "install", "--production", "--frozen-lockfile", "--ignore-scripts"
    end

    (bin/"kesha").write <<~EOS
      #!/bin/bash
      exec "#{formula_opt_bin("oven-sh/bun/bun")}/bun" "#{libexec}/bin/kesha.js" "$@"
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/kesha --version")
    # The commands that read staged assets — a payload missing them still passes --version (#914).
    assert_match "complete -c kesha", shell_output("#{bin}/kesha completions fish")
    assert_match ".TH KESHA 1", shell_output("#{bin}/kesha manpage")
  end
end

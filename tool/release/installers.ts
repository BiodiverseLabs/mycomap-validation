// The one-line installs, written by the build for each release:
//
//   Windows (PowerShell):   irm <release>/install.ps1 | iex
//   macOS and Linux:        curl -fsSL <release>/install.sh | sh
//
// Each script carries its release's version and the SHA-256 of each .zip
// (the same as SHA256SUMS.txt), downloads the one for this computer, refuses
// it unless the checksum matches, unpacks it into the person's own folders
// (no administrator), puts `mycomap-validation` and `mmv` on their PATH, and
// runs `mycomap-validation init`, which asks before it downloads anything.
//
// Where it goes (each can be changed with an environment variable):
//   Windows   %LOCALAPPDATA%\Programs\MycoMap Validation\<download>\, commands in ...\bin
//             (MYCOMAP_VALIDATION_INSTALL_DIR); the user's own Path
//   macOS, Linux  ~/.local/share/mycomap-validation/<download>/, links in ~/.local/bin
//             (MYCOMAP_VALIDATION_INSTALL_DIR, MYCOMAP_VALIDATION_BIN_DIR); a line in the
//             shell's profile when ~/.local/bin is not on the PATH yet
// MYCOMAP_VALIDATION_NO_INIT=1 installs without running init.
import { downloadName } from "./launchers";
import { isWindows, type DownloadPlatform } from "./nodeRuntime";

export interface BuiltDownload {
  platform: DownloadPlatform;
  sha256: string;
  bytes: number;
}

export interface InstallerOptions {
  version: string;
  /** The folder address the release's files are downloaded from, ending in "/". */
  base: string;
  downloads: BuiltDownload[];
}

/** Where a release's files are: the tag's own GitHub release. */
export function releaseBase(version: string): string {
  return `https://github.com/BiodiverseLabs/mycomap-validation/releases/download/v${version}/`;
}

const megabytes = (bytes: number) => Math.max(1, Math.round(bytes / 1e6));

/** A value inside a PowerShell single-quoted string. */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * install.ps1, for Windows PowerShell 5.1 (the one Windows comes with) and
 * later. Pure ASCII, since PowerShell 5.1 may read a downloaded script in
 * another encoding. All of it runs inside & { }, so a failure stops the
 * install without closing the person's PowerShell window.
 */
export function installPs1(opts: InstallerOptions): string | null {
  const win = opts.downloads.find((d) => isWindows(d.platform));
  if (!win) return null;
  const name = downloadName(opts.version, win.platform);
  const lines = [
    `# MycoMap Validation ${opts.version} for Windows: the one-line install. In PowerShell:`,
    `#   irm ${opts.base}install.ps1 | iex`,
    "# Downloads the Windows build, checks its SHA-256, unpacks it into your own",
    "# folder (no administrator needed), puts mycomap-validation and mmv on your",
    "# Path (yours only), and runs \"mycomap-validation init\", which asks first.",
    "& {",
    "  $ErrorActionPreference = 'Stop'",
    "  $ProgressPreference = 'SilentlyContinue'",
    `  $version = ${psQuote(opts.version)}`,
    `  $name = ${psQuote(name)}`,
    `  $url = ${psQuote(`${opts.base}${name}.zip`)}`,
    `  $sha256 = ${psQuote(win.sha256)}`,
    "  $root = $env:MYCOMAP_VALIDATION_INSTALL_DIR",
    "  if (-not $root) { $root = Join-Path $env:LOCALAPPDATA 'Programs\\MycoMap Validation' }",
    "  # The user's own environment variable for the command path (tests name another).",
    "  $pathName = $env:MYCOMAP_VALIDATION_TEST_PATH_VARIABLE",
    "  if (-not $pathName) { $pathName = 'Path' }",
    "  $bin = Join-Path $root 'bin'",
    "",
    "  Write-Host \"Installing MycoMap Validation $version into $root\"",
    "  Write-Host '(a folder of your own: no administrator needed).'",
    "  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }",
    "  New-Item -ItemType Directory -Force -Path $root | Out-Null",
    "  $zip = Join-Path $root \"$name.download.zip\"",
    `  Write-Host "Downloading $url (${megabytes(win.bytes)} MB)..."`,
    "  try { Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing }",
    "  catch { throw \"Could not download $url ($($_.Exception.Message)). Check the internet connection and run the same line again.\" }",
    "  Write-Host 'Checking that it is the published file (SHA-256)...'",
    "  $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()",
    "  if ($got -ne $sha256) {",
    "    Remove-Item -LiteralPath $zip -Force",
    "    throw \"The download is not the published file: its SHA-256 is $got, not $sha256. Nothing was installed. Run the same line again.\"",
    "  }",
    "  Write-Host 'Unpacking...'",
    "  $staging = Join-Path $root '.unpacking'",
    "  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }",
    "  Expand-Archive -LiteralPath $zip -DestinationPath $staging -Force",
    "  $target = Join-Path $root $name",
    "  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }",
    "  Move-Item -LiteralPath (Join-Path $staging $name) -Destination $target",
    "  Remove-Item -LiteralPath $staging -Recurse -Force",
    "  Remove-Item -LiteralPath $zip -Force",
    "",
    "  # The commands on the Path: small .cmd files that run this version.",
    "  New-Item -ItemType Directory -Force -Path $bin | Out-Null",
    "  foreach ($command in @('mycomap-validation', 'mmv')) {",
    "    $text = \"@echo off`r`nrem MycoMap Validation $version, installed by install.ps1.`r`n`\"%~dp0..\\$name\\$command.cmd`\" %*`r`n\"",
    "    [IO.File]::WriteAllText((Join-Path $bin \"$command.cmd\"), $text, [Text.Encoding]::ASCII)",
    "  }",
    "  Get-ChildItem -LiteralPath $root -Directory -Filter 'mycomap-validation-*' | Where-Object { $_.Name -ne $name } | ForEach-Object {",
    "    try { Remove-Item -LiteralPath $_.FullName -Recurse -Force; Write-Host \"Removed the older $($_.Name).\" }",
    "    catch { Write-Host \"Could not remove the older $($_.Name) (is it open?); delete that folder later.\" }",
    "  }",
    "",
    "  # Your own Path, read and written as it is stored (entries like %USERPROFILE%\\... stay as they are).",
    "  $key = Get-Item -LiteralPath 'HKCU:\\Environment'",
    "  $stored = $key.GetValue($pathName, '', 'DoNotExpandEnvironmentNames')",
    "  $entries = @($stored -split ';' | Where-Object { $_ -ne '' })",
    "  if ($entries -contains $bin) {",
    "    Write-Host \"$bin is already on your Path.\"",
    "  } else {",
    "    New-ItemProperty -LiteralPath 'HKCU:\\Environment' -Name $pathName -PropertyType ExpandString -Value (($entries + $bin) -join ';') -Force | Out-Null",
    "    # Tells Windows the environment changed, so new terminals see it.",
    "    [Environment]::SetEnvironmentVariable('MYCOMAP_VALIDATION_INSTALLING', '1', 'User')",
    "    [Environment]::SetEnvironmentVariable('MYCOMAP_VALIDATION_INSTALLING', $null, 'User')",
    "    Write-Host \"Added $bin to your Path (yours only).\"",
    "  }",
    "  if ($pathName -eq 'Path' -and (@($env:Path -split ';') -notcontains $bin)) { $env:Path = \"$env:Path;$bin\" }",
    "",
    "  $tool = Join-Path $bin 'mycomap-validation.cmd'",
    "  & $tool --version",
    "  if ($LASTEXITCODE -ne 0) { throw 'The installed tool did not start. Please report it at https://github.com/BiodiverseLabs/mycomap-validation/issues' }",
    "  Write-Host ''",
    "  Write-Host 'Installed. From now on, in any terminal: mycomap-validation (or mmv for short).'",
    "  if ($env:MYCOMAP_VALIDATION_NO_INIT) { Write-Host 'Next, set up the databases and BLAST+:  mycomap-validation init'; return }",
    "  Write-Host 'Now setting up the databases and BLAST+ (mycomap-validation init). It says what it will download, and how big, and asks first.'",
    "  Write-Host ''",
    "  & $tool init",
    "}",
    "",
  ];
  return lines.join("\r\n");
}

const NAME_OF_SH: Record<string, string> = {
  "macos-arm64": "Darwin-arm64",
  "macos-x64": "Darwin-x86_64",
  "linux-x64": "Linux-x86_64",
  "linux-arm64": "Linux-aarch64",
};

/** install.sh, for macOS and Linux, in plain POSIX sh (run as `curl -fsSL … | sh`). */
export function installSh(opts: InstallerOptions): string | null {
  const unix = opts.downloads.filter((d) => !isWindows(d.platform));
  if (!unix.length) return null;
  const cases = unix.map((d) => `  ${NAME_OF_SH[d.platform]}) name=${downloadName(opts.version, d.platform)}; sha256=${d.sha256}; size="${megabytes(d.bytes)} MB" ;;`);
  return `#!/bin/sh
# MycoMap Validation ${opts.version} for macOS and Linux: the one-line install.
#   curl -fsSL ${opts.base}install.sh | sh
# Downloads the build for this computer, checks its SHA-256, unpacks it into
# your own folders (no administrator needed), puts mycomap-validation and mmv
# on your PATH, and runs "mycomap-validation init", which asks first.
set -eu

version=${opts.version}
base=${opts.base}
say() { printf '%s\\n' "$*"; }
fail() { printf 'MycoMap Validation was not installed: %s\\n' "$*" >&2; exit 1; }

os=$(uname -s)
arch=$(uname -m)
case "$arch" in arm64|aarch64) [ "$os" = Linux ] && arch=aarch64 || arch=arm64 ;; esac
# A Mac with Apple silicon running this terminal under Rosetta still gets the Apple silicon build.
if [ "$os" = Darwin ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi
case "$os-$arch" in
${cases.join("\n")}
  *) fail "there is no download for this computer ($os $arch). See https://github.com/BiodiverseLabs/mycomap-validation#readme" ;;
esac

root=\${MYCOMAP_VALIDATION_INSTALL_DIR:-$HOME/.local/share/mycomap-validation}
bin=\${MYCOMAP_VALIDATION_BIN_DIR:-$HOME/.local/bin}
say "Installing MycoMap Validation $version into $root"
say "(folders of your own: no administrator needed)."
mkdir -p "$root" "$bin"
zip="$root/$name.download.zip"

say "Downloading $base$name.zip ($size)..."
if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 3 --progress-bar -o "$zip" "$base$name.zip" || fail "could not download $base$name.zip. Check the internet connection and run the same line again."
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$zip" "$base$name.zip" || fail "could not download $base$name.zip. Check the internet connection and run the same line again."
else
  fail "neither curl nor wget is installed."
fi

say "Checking that it is the published file (SHA-256)..."
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$zip" | cut -d' ' -f1)
else got=$(shasum -a 256 "$zip" | cut -d' ' -f1); fi
if [ "$got" != "$sha256" ]; then
  rm -f "$zip"
  fail "the download is not the published file: its SHA-256 is $got, not $sha256. Run the same line again."
fi

say "Unpacking..."
staging="$root/.unpacking"
rm -rf "$staging"
mkdir -p "$staging"
if [ "$os" = Darwin ]; then ditto -x -k "$zip" "$staging"
elif command -v unzip >/dev/null 2>&1; then unzip -q "$zip" -d "$staging"
else rm -rf "$staging"; fail "unzip is not installed (on Ubuntu or Debian: sudo apt install unzip), then run the same line again."; fi
rm -rf "$root/$name"
mv "$staging/$name" "$root/$name"
rm -rf "$staging" "$zip"
for old in "$root"/mycomap-validation-*; do
  if [ -d "$old" ] && [ "$old" != "$root/$name" ]; then rm -rf "$old" && say "Removed the older $(basename "$old")."; fi
done

# The commands on the PATH: links to this version.
for command in mycomap-validation mmv; do ln -sf "$root/$name/$command" "$bin/$command"; done
case ":$PATH:" in
  *":$bin:"*) say "$bin is already on your PATH." ;;
  *)
    case "\${SHELL:-}" in
      */zsh) profile="$HOME/.zshrc" ;;
      */bash) if [ "$os" = Darwin ]; then profile="$HOME/.bash_profile"; else profile="$HOME/.bashrc"; fi ;;
      *) profile="$HOME/.profile" ;;
    esac
    if ! grep -q 'MycoMap Validation' "$profile" 2>/dev/null; then
      printf '\\n# MycoMap Validation (added by its installer)\\nexport PATH="%s:$PATH"\\n' "$bin" >> "$profile"
      say "Added $bin to your PATH, in $profile (it takes effect in new terminals)."
    fi
    PATH="$bin:$PATH"
    ;;
esac

"$bin/mycomap-validation" --version || fail "the installed tool did not start. Please report it at https://github.com/BiodiverseLabs/mycomap-validation/issues"
say ""
say "Installed. In a new terminal: mycomap-validation (or mmv for short)."
# Piped into sh, this script has no keyboard to ask with; init reads its answer from the terminal itself.
if [ -z "\${MYCOMAP_VALIDATION_NO_INIT:-}" ] && [ -t 1 ] && (: </dev/tty) 2>/dev/null; then
  say "Now setting up the databases and BLAST+ (mycomap-validation init). It says what it will download, and how big, and asks first."
  say ""
  "$bin/mycomap-validation" init </dev/tty
else
  say "Next, set up the databases and BLAST+:  mycomap-validation init"
fi
`;
}

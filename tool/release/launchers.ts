// What a download holds besides Node.js and the tool's one script: the
// commands people type (`mycomap-validation`, and `mmv` for short) and a
// README.txt with the first run.
//
//   mycomap-validation-<version>-<platform>/
//     mycomap-validation  mmv            (.cmd on Windows)
//     README.txt  LICENSE.txt  THIRD_PARTY_NOTICES.md
//     lib/node  lib/mycomap-validation.mjs  lib/NODE_LICENSE.txt
import { isWindows, PINNED_NODE, type DownloadPlatform } from "./nodeRuntime";

/** The names the tool answers to. */
export const COMMAND_NAMES = ["mycomap-validation", "mmv"] as const;
export const BUNDLE_FILE = "mycomap-validation.mjs";

/** The folder (and .zip) name of a download. */
export function downloadName(version: string, platform: DownloadPlatform): string {
  return `mycomap-validation-${version}-${platform}`;
}

/**
 * The macOS and Linux command: finds its own folder (through any links to it,
 * so it can be linked from a folder on the PATH) and runs the tool with the
 * Node.js beside it. INIT_CWD is pnpm's, and means nothing here.
 */
export function shLauncher(version: string): string {
  return `#!/bin/sh
# MycoMap Validation ${version}: runs the tool with the Node.js in lib/.
# A link to this file from a folder on your PATH works too.
self=$0
while [ -h "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=$(dirname "$self")/$link ;;
  esac
done
here=$(cd "$(dirname "$self")" && pwd -P) || exit 3
unset INIT_CWD
exec "$here/lib/node" "$here/lib/${BUNDLE_FILE}" "$@"
`;
}

/** The Windows command (a .cmd file, which cmd.exe needs with CRLF line ends). */
export function cmdLauncher(version: string): string {
  return [
    "@echo off",
    `rem MycoMap Validation ${version}: runs the tool with the Node.js in lib\\.`,
    "setlocal",
    'set "INIT_CWD="',
    `"%~dp0lib\\node.exe" "%~dp0lib\\${BUNDLE_FILE}" %*`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}

const SYSTEM_NAMES: Record<DownloadPlatform, string> = {
  "windows-x64": "Windows (x64; Windows on ARM runs it too)",
  "macos-arm64": "macOS on Apple silicon (M1 and later)",
  "macos-x64": "macOS on Intel",
  "linux-x64": "Linux (x64)",
  "linux-arm64": "Linux (ARM64)",
};

/** README.txt: the first run, in plain text, for the system the download is for. */
export function readmeText(version: string, platform: DownloadPlatform): string {
  const win = isWindows(platform);
  const cmd = win ? ".\\mycomap-validation" : "./mycomap-validation";
  const open = win
    ? [
      "1. Open a terminal in this folder: in File Explorer, open the folder, then",
      "   right-click an empty part of it and choose \"Open in Terminal\" (or type",
      "   powershell in the address bar and press Enter).",
    ]
    : platform.startsWith("macos-")
      ? [
        "1. Open Terminal (in Applications > Utilities), type  cd  and a space, drag",
        "   this folder onto the Terminal window, and press Return.",
      ]
      : ["1. Open a terminal in this folder."];
  const lines = [
    `MycoMap Validation ${version} for ${SYSTEM_NAMES[platform]}`,
    "",
    "Names fungal ITS sequences with MycoMap's rules, on this computer. Nothing",
    `else needs installing: the Node.js ${PINNED_NODE} it runs on is in the lib folder.`,
    "",
    ...open,
    "",
    "2. Set it up, once (it says what it will download, and how big, before it",
    "   starts: MycoMap's database, GenBank's fungal ITS and BLAST+):",
    "",
    `     ${cmd} init`,
    "",
    "3. Name your sequences:",
    "",
    `     ${cmd} run my-sequences.fasta`,
    "",
    "   or use it in your browser:",
    "",
    `     ${cmd} ui`,
    "",
    `mmv is a short name for the same command (${win ? ".\\mmv" : "./mmv"} run my-sequences.fasta).`,
    "After init, nothing needs the internet. Run init again to update the",
    "databases. The results go in a folder next to the FASTA file.",
    "",
    `Every option:  ${cmd} help`,
    "The full guide: https://github.com/BiodiverseLabs/mycomap-validation#readme",
  ];
  if (platform.startsWith("macos-")) {
    lines.push(
      "",
      "If macOS says the tool cannot be opened or checked: open System Settings >",
      "Privacy & Security, scroll down to the message about it, click \"Open Anyway\",",
      "and run the command again. Or, in Terminal in this folder, run once:",
      "",
      "     xattr -dr com.apple.quarantine .",
    );
  }
  return `${lines.join(win ? "\r\n" : "\n")}${win ? "\r\n" : "\n"}`;
}

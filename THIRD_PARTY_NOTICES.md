# Third-party notices

## adjusted-identity

`src/adjustedIdentity.ts` is a TypeScript port of the Python package
adjusted-identity, version 0.2.6, by Josh Walker
(https://github.com/joshuaowalker/adjusted-identity). `test-vectors/adjusted-identity.json`
holds made-up aligned pairs with the answers that package gives for them, so
the port can be checked against it. The package's licence:

```
BSD 2-Clause License

Copyright (c) 2025, Josh Walker

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Node.js, in the downloads

Each download from the repository's releases includes Node.js (the `node`
program in its `lib` folder), taken unchanged from https://nodejs.org at the
version and checksum pinned in `tool/release/nodeRuntime.ts`. Node.js is
under the MIT licence, with the licences of the libraries it includes; the
full text is `lib/NODE_LICENSE.txt` in each download, and
https://github.com/nodejs/node/blob/main/LICENSE.

The tool's own script in the download (`lib/mycomap-validation.mjs`) is this
repository's code, bundled into one file by esbuild (MIT), which adds no code
of its own beyond small helpers.

## BLAST+ and the downloaded databases

The tool does not include BLAST+ or any database. `init` downloads them to
your computer from their publishers:

- **BLAST+ 2.17.0**, from NCBI
  (https://ftp.ncbi.nlm.nih.gov/blast/executables/blast+/2.17.0/). Only
  blastn and blastdbcmd are kept. NCBI's notice for it:

  ```
  PUBLIC DOMAIN NOTICE
  National Center for Biotechnology Information

  This software/database is a "United States Government Work" under the
  terms of the United States Copyright Act.  It was written as part of
  the author's official duties as a United States Government employee and
  thus cannot be copyrighted.  This software/database is freely available
  to the public for use. The National Library of Medicine and the U.S.
  Government have not placed any restriction on its use or reproduction.

  Although all reasonable efforts have been taken to ensure the accuracy
  and reliability of the software and data, the NLM and the U.S.
  Government do not and cannot warrant the performance or results that
  may be obtained by using this software or data. The NLM and the U.S.
  Government disclaim all warranties, express or implied, including
  warranties of performance, merchantability or fitness for any particular
  purpose.

  Please cite the author in any work or product based on this material.
  ```

- **MycoMap's BLAST database and names table**, from
  https://mycomap.org/data-downloads, under CC BY 4.0.
- **GenBank's fungal ITS database**, built from NCBI GenBank and RefSeq
  records; see NCBI's terms at https://www.ncbi.nlm.nih.gov/home/about/policies/.

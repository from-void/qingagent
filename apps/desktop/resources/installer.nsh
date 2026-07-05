; electron-builder 自动 include 本文件(buildResources/installer.nsh)。
; Windows-only 压缩器覆盖:electron-builder 默认给 NSIS 用 solid-lzma,压缩 ~300MB
; payload(electron 200MB + app.asar 91MB)在 CI windows runner 上 30min+ 卡死。
; 改用 zlib(更快,体积略大但可接受)。/FINAL 锁定,防止 electron-builder 后续
; SetCompressor 覆盖本设置。只影响 windows nsis,不动 linux/mac。
!macro customHeader
  SetCompressor /FINAL zlib
!macroend

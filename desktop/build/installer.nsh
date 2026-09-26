; 安装程序自定义脚本
; 目标：默认安装到 D 盘（若 D 盘存在），避免占用 C 盘；用户仍可手动更改安装目录。

!include LogicLib.nsh

!macro preInit
  SetRegView 64
  ${If} ${FileExists} "D:\*.*"
    WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\GalleryMirror"
    WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\GalleryMirror"
  ${EndIf}
!macroend

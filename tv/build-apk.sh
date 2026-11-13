#!/bin/zsh
# 编译电视 APP，放到 src-tauri/tv/BanzouKTV.apk（电脑上的波点会把它打包进去，「电视」窗口里一键装到电视）
# 需要 JDK 17 和 Android SDK（platforms;android-34、build-tools;34.0.0）
set -e
cd "${0:A:h}"
export JAVA_HOME=${JAVA_HOME:-$HOME/Library/Android/jdk/Contents/Home}
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Library/Android/sdk}
./gradlew -q assembleDebug
mkdir -p ../src-tauri/tv
cp app/build/outputs/apk/debug/app-debug.apk ../src-tauri/tv/BanzouKTV.apk
echo "已生成 src-tauri/tv/BanzouKTV.apk（versionCode 要和 src-tauri/src/tv.rs 里的 APP_VERSION 一致）"

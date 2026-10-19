#!/usr/bin/env bash
# Builds the signed Android APK using the Android SDK and JDK installed on the Windows host.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
WINBUILD=/mnt/c/Users/luiss/AppData/Local/NextNoteBuild
WINBUILD_WIN='C:\Users\luiss\AppData\Local\NextNoteBuild'
JAVA_HOME_WIN='C:\Program Files\Android\Android Studio\jbr'
SDK_WIN='C\:\\Users\\luiss\\AppData\\Local\\Android\\Sdk'

npm run build
npx cap sync android

mkdir -p "$WINBUILD/node_modules/@capacitor"
rsync -a --delete --exclude '/app/build' --exclude '/build' --exclude '/.gradle' --exclude '/capacitor-cordova-android-plugins/build' android/ "$WINBUILD/android/"
for p in android app browser; do
  rsync -a --delete --exclude 'build/' "node_modules/@capacitor/$p/" "$WINBUILD/node_modules/@capacitor/$p/"
done
echo "sdk.dir=$SDK_WIN" > "$WINBUILD/android/local.properties"

cd "$WINBUILD/android"
# start the Gradle wrapper directly (gradlew.bat loses an empty argument when called through WSL interop)
env -u ELECTRON_RUN_AS_NODE JAVA_HOME="$JAVA_HOME_WIN" WSLENV=JAVA_HOME \
  "/mnt/c/Program Files/Android/Android Studio/jbr/bin/java.exe" -Xmx64m -Xms64m -Dorg.gradle.appname=gradlew \
  -jar gradle/wrapper/gradle-wrapper.jar assembleRelease --console=plain
cd - > /dev/null
mkdir -p release
cp "$WINBUILD/android/app/build/outputs/apk/release/app-release.apk" "release/NextNote-$VERSION.apk"
echo "APK: release/NextNote-$VERSION.apk"

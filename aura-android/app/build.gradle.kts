plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.aura.companion"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.aura.companion"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    // WebViewAssetLoader: serves the bundled web app over an https:// origin,
    // which keeps it a secure context so the camera and mic still work.
    implementation("androidx.webkit:webkit:1.11.0")
}

// Keep one copy of the web app. It lives in aura-ai/web/ and is copied into the APK at
// build time, so standalone mode can't drift from what the PC server serves.
val copyWebAssets by tasks.registering(Copy::class) {
    from(rootProject.file("../aura-ai/web"))
    into(layout.projectDirectory.dir("src/main/assets/web"))
}
tasks.named("preBuild") { dependsOn(copyWebAssets) }

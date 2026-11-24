# Each ML Kit library contains its own copy of renamed internal classes, which are wired together at
# runtime via component registration. With R8 enabled in the release build, these classes would be
# merged and obfuscated, resulting in NullPointerExceptions on device (e.g., language recognition
# reading a class from another library). Prevent R8 from modifying the entire ML Kit.
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_** { *; }

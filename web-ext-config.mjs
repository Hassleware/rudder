import os from "node:os";
import path from "node:path";

export default {
  sourceDir: "extension",
  artifactsDir: "dist",
  run: {
    // Store-installed Firefox: the WindowsApps alias survives Firefox updates (the real path has the version in it).
    firefox: path.join(os.homedir(), "AppData", "Local", "Microsoft", "WindowsApps", "firefox.exe"),
    // A dev profile that's kept between runs (signed in, models downloaded once). Your normal profile is untouched.
    firefoxProfile: path.join(import.meta.dirname, ".dev-profile"), // absolute: Store Firefox starts in another folder
    profileCreateIfMissing: true,
    keepProfileChanges: true,
    startUrl: ["https://www.youtube.com"],
  },
};

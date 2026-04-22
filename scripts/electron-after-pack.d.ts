declare module "../scripts/electron-after-pack.mjs" {
  interface AfterPackContext {
    appOutDir: string;
    electronPlatformName: string;
    packager: {
      appInfo: {
        productFilename: string;
      };
    };
  }

  export default function afterPack(context: AfterPackContext): Promise<void>;
}

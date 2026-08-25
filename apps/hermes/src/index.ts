import { boot } from "./boot";

boot().catch((error) => {
  console.error(error);
  process.exit(1);
});

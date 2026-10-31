// chalk-web -- 129-5: the seasonal figures as files.
//
// This file has one import for each cut-out. The esbuild file loader hashes
// each PNG like any other asset, and tsc knows the names.
// The icon sheet that the cut-outs came from is not in the repository.
// tools/cut-season-sheet.py made the cut-outs from that sheet.
// The keys have the form "<season>/<figure>", as in the registry in
// seasons.ts.

import halloweenPumpkin from "../../assets/season/halloween/pumpkin.png";
import halloweenGhost from "../../assets/season/halloween/ghost.png";
import halloweenWitchHat from "../../assets/season/halloween/witch-hat.png";
import halloweenCauldron from "../../assets/season/halloween/cauldron.png";
import halloweenBlackCat from "../../assets/season/halloween/black-cat.png";
import halloweenSkullCandle from "../../assets/season/halloween/skull-candle.png";
import halloweenBat from "../../assets/season/halloween/bat.png";
import halloweenSpiderWeb from "../../assets/season/halloween/spider-web.png";
import halloweenScarecrow from "../../assets/season/halloween/scarecrow.png";
import halloweenHauntedLantern from "../../assets/season/halloween/haunted-lantern.png";
import winterSnowflake from "../../assets/season/winter/snowflake.png";
import winterSnowman from "../../assets/season/winter/snowman.png";
import winterPineTree from "../../assets/season/winter/pine-tree.png";
import winterIceCrystal from "../../assets/season/winter/ice-crystal.png";
import winterArcticFox from "../../assets/season/winter/arctic-fox.png";
import winterWinterLantern from "../../assets/season/winter/winter-lantern.png";
import winterSignpost from "../../assets/season/winter/signpost.png";
import winterIcicles from "../../assets/season/winter/icicles.png";
import winterScarf from "../../assets/season/winter/scarf.png";
import winterMittens from "../../assets/season/winter/mittens.png";

export interface Figure {
  /** the hashed URL of the cut-out in the bundle */
  src: string;
  /** what the figure is, for the accessible name of the image: "a pumpkin" */
  label: string;
}

/** FIGURES maps "<season>/<figure>" to the cut-out of that figure. */
export const FIGURES: Record<string, Figure> = {
  "halloween/pumpkin": { src: halloweenPumpkin, label: "a pumpkin" },
  "halloween/ghost": { src: halloweenGhost, label: "a ghost" },
  "halloween/witch-hat": { src: halloweenWitchHat, label: "a witch's hat" },
  "halloween/cauldron": { src: halloweenCauldron, label: "a cauldron" },
  "halloween/black-cat": { src: halloweenBlackCat, label: "a black cat" },
  "halloween/skull-candle": { src: halloweenSkullCandle, label: "a skull and a candle" },
  "halloween/bat": { src: halloweenBat, label: "a bat" },
  "halloween/spider-web": { src: halloweenSpiderWeb, label: "a spider in its web" },
  "halloween/scarecrow": { src: halloweenScarecrow, label: "a scarecrow" },
  "halloween/haunted-lantern": { src: halloweenHauntedLantern, label: "a haunted lantern" },
  "winter/snowflake": { src: winterSnowflake, label: "a snowflake" },
  "winter/snowman": { src: winterSnowman, label: "a snowman" },
  "winter/pine-tree": { src: winterPineTree, label: "a snowy pine" },
  "winter/ice-crystal": { src: winterIceCrystal, label: "an ice crystal" },
  "winter/arctic-fox": { src: winterArcticFox, label: "an arctic fox" },
  "winter/winter-lantern": { src: winterWinterLantern, label: "a winter lantern" },
  "winter/signpost": { src: winterSignpost, label: "a snowed-in signpost" },
  "winter/icicles": { src: winterIcicles, label: "icicles" },
  "winter/scarf": { src: winterScarf, label: "a scarf" },
  "winter/mittens": { src: winterMittens, label: "a pair of mittens" },
};

# Court location comparisons

Before uses PR #29 source at `20f8fd10998f08138c2eba199a7b699845230a98`; after uses this feature branch. Both show the same synthetic local records with intercepted geocoding, court results and illustrative map tiles. The screenshots demonstrate the actual React/Leaflet interface; they do not claim live venue or tile-provider accuracy. Full-page images may exceed the viewport height.

| Surface | Desktop before | Desktop after | Mobile before | Mobile after |
| --- | --- | --- | --- | --- |
| Default court finder | [Before](before/courts-default-desktop.png) | [After](after/courts-default-desktop.png) | [Before](before/courts-default-mobile.png) | [After](after/courts-default-mobile.png) |
| Court selection and pins | [Before](before/court-selection-desktop.png) | [After](after/court-selection-desktop.png) | [Before](before/court-selection-mobile.png) | [After](after/court-selection-mobile.png) |
| Create rally location | [Before](before/create-location-desktop.png) | [After](after/create-location-desktop.png) | [Before](before/create-location-mobile.png) | [After](after/create-location-mobile.png) |
| Edit rally location | [Before](before/edit-location-desktop.png) | [After](after/edit-location-desktop.png) | [Before](before/edit-location-mobile.png) | [After](after/edit-location-mobile.png) |
| Rally map and calendar actions | [Before](before/rally-location-desktop.png) | [After](after/rally-location-desktop.png) | [Before](before/rally-location-mobile.png) | [After](after/rally-location-mobile.png) |

Desktop viewport: 1440×1000. Mobile viewport: 390×844. The create/edit captures show the visible scrollable dialog; browser tests separately verify that later controls are reachable on a 320px screen. [Verification and reproduction](../../location-ux-verification.md).

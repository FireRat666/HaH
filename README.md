# Holograms Against Humanity
==========================

A terrible game for terrible people, now in your favorite virtual worlds. This is a clone of Cards Against Humanity designed to be easily embedded in social VR platforms like BanterVR.

**Important Architectural Change**: This version of Holograms Against Humanity is now entirely client-side. It no longer relies on a Node.js server, WebSockets, or A-Frame. All game logic and synchronization are handled directly within the `hah.js` script using Banter Space state properties, making it suitable for static hosting. It reads deck and audio data from external files.

* Adapted for AltspaceVR by: Derogatory, falkrons, schmidtec
* Ported to Banter by Shane, Improved and ported from Glitch by FireRat
* Card Data & Logic: ([JSON Against Humanity](https://github.com/FireRat666/Json-Against-Humanity))

## Features

*   **Multiplayer Fun**: Play with up to 10 players, with game state synchronized via Banter Space properties.
*   **Player Reconnect**: Disconnected players can rejoin a game in progress.
*   **Host-Selectable Expansions**: The Host can dynamically choose which card expansions to include from a built-in library of over 70 official and unofficial packs directly from the in-game "DECK OPTIONS" UI.
*   **Easy Integration**: Embed the game into any web-based world with a single script tag, requiring only static hosting.

## Customization

You can customize the game by adding attributes to the `<script>` tag that loads `hah.js`. This is especially useful when embedding the game in platforms like BanterVR.

Here's an example of how you might use it:

```html
<script src="https://hah.firer.at/hah.js"
        position="0 -0.4 -5"
        instance="my-private-game"></script>
```

### Available Attributes

*   `position`: (Default: `"0 0 0"`) Sets the `x y z` position of the game table in the world.
*   `rotation`: (Default: `"0 0 0"`) Sets the `x y z` rotation of the game table.
*   `instance`: (Default: `"demo-game"`) A unique name for the game room. All players with the same instance name will join the same game.
*   `debug`: (Default: `"false"`) Set to `"true"` to enable extra logging in the browser's developer console.

## SideQuest / Altspace Creator SDK (Snippet)

In a SideQuest/Altspace Creator SDK world, add an empty GameObject at the origin, click **Add Component > BS > Snippet** and type `hah`. Or paste it into `Assets/WebRoot/index.html` between the snippet section comments:

```html
<!-- snippet section -->
<bs-snippet name="hah" title="Holograms Against Humanity"
  description="Synced multiplayer party card game table."
  script="https://hah.firer.at/snippet.js"
  room=""
  position="0 0 3"
  rotation="0 0 0"
  debug="false">
  <bs-gizmo type="position" attribute="position"/>
  <bs-gizmo type="plane" attribute="position" size="3.2 3.2" rotation="90 0 0"/>
</bs-snippet>
<!-- end snippet section -->
```

- Settings are the same as the script attributes above. `position` and `rotation` are Unity world values.
- Each placement is its own game. Its sync id is `room`, or the placement's own id when `room` is empty. Give placements the same `room` to share one game.
- An empty setting uses the game's default.
- The Scene-view gizmo shows the table footprint.
- Unity reads the snippet section as XML: quote every attribute, close every element, and write `&` as `&amp;`.

## Game Setup & Deck Selection

When the game initializes, it defaults to using the **CAH Base Set**. 

If you are the Host (or if you claim Host in an empty room), you can configure the game before starting:
1. Click the **DECK OPTIONS** button on the central hub.
2. Scroll through the available expansions and click to toggle them on or off (green means selected).
3. Click **SAVE DECKS** to commit your choices.
4. Click **START ROUND** to begin the game!
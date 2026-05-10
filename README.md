# Holograms Against Humanity
==========================

A terrible game for terrible people, now in your favorite virtual worlds. This is a clone of Cards Against Humanity designed to be easily embedded in social VR platforms like BanterVR.

**Important Architectural Change**: This version of Holograms Against Humanity is now entirely client-side. It no longer relies on a Node.js server, WebSockets, or A-Frame. All game logic and synchronization are handled directly within the `hah.js` script using Banter Space state properties, making it suitable for static hosting. It reads deck and audio data from external files.

* Adapted for AltspaceVR by: Derogatory, falkrons, schmidtec
* Ported to Banter by Shane, Improved and ported from Glitch by FireRat

## Features

*   **Multiplayer Fun**: Play with up to 10 players, with game state synchronized via Banter Space properties.
*   **Player Reconnect**: Disconnected players can rejoin a game in progress.
*   **Host-Selectable Expansions**: The Host can dynamically choose which card expansions to include from a built-in library of over 70 official and unofficial packs directly from the in-game "DECK OPTIONS" UI.
*   **Easy Integration**: Embed the game into any web-based world with a single script tag, requiring only static hosting.

## Customization

You can customize the game by adding attributes to the `<script>` tag that loads `hah.js`. This is especially useful when embedding the game in platforms like BanterVR.

Here's an example of how you might use it:

```html
<script src="https://your-static-host.com/hah.js"
        position="0 1 -5" 
        rotation="0 90 0" 
        instance="my-private-game"></script>
```

### Available Attributes

*   `position`: (Default: `"0 0 0"`) Sets the `x y z` position of the game table in the world.
*   `rotation`: (Default: `"0 0 0"`) Sets the `x y z` rotation of the game table.
*   `instance`: (Default: `"demo-game"`) A unique name for the game room. All players with the same instance name will join the same game.
*   `debug`: (Default: `"false"`) Set to `"true"` to enable extra logging in the browser's developer console.

## Game Setup & Deck Selection

When the game initializes, it defaults to using the **CAH Base Set**. 

If you are the Host (or if you claim Host in an empty room), you can configure the game before starting:
1. Click the **DECK OPTIONS** button on the central hub.
2. Scroll through the available expansions and click to toggle them on or off (green means selected).
3. Click **SAVE DECKS** to commit your choices.
4. Click **START ROUND** to begin the game!

## Deck Formatting Tool - For Older Version

To make it easier to use custom card decks, this project includes a utility called `formatter.html`. This tool allows you to convert card decks from [CrCast](https://cast.clrtd.com/) (Cards Against Humanity online) into a format compatible with Holograms Against Humanity.

### How to Use `formatter.html`

1.  **Open the Formatter**: Go to the hosted formatter tool at [https://banter-hah.firer.at/formatter.html](https://banter-hah.firer.at/formatter.html) in your web browser.
2.  **Get CrCast Deck Code**:
    *   Go to [CrCast](https://cast.clrtd.com/) to find a deck.
    *   If the deck code doesn't work directly in the formatter, you may need to manually extract the JSON. Use the [API](https://cast.clrtd.com/api) URL and insert the deck code.
    *   Example API URL: `https://api.crcast.cc/v1/cc/decks/CODE/cards/` (replace `CODE` with the actual deck code).
3.  **Paste JSON Data**: Copy the RAW JSON Data (either directly from CrCast if it works, or from the API if manual extraction was needed) and paste it into the input box on the formatter page.
4.  **Format and Copy**: Click the "Format" button. You can then copy the formatted JSON, which is ready to be used with Holograms Against Humanity.
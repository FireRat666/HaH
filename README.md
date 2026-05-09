# Holograms Against Humanity
==========================

A terrible game for terrible people, now in your favorite virtual worlds. This is a clone of Cards Against Humanity designed to be easily embedded in social VR platforms like BanterVR.

**Important Architectural Change**: This version of Holograms Against Humanity is now entirely client-side. It no longer relies on a Node.js server, WebSockets, or A-Frame. All game logic and synchronization are handled directly within the `hah.js` script using Banter Space state properties, making it suitable for static hosting. It reads deck and audio data from external files.

* Adapted for AltspaceVR by: Derogatory, falkrons, schmidtec
* Ported to Banter by Shane, Improved and ported from Glitch by FireRat

## Features

*   **Multiplayer Fun**: Play with up to 10 players, with game state synchronized via Banter Space properties.
*   **Player Reconnect**: Disconnected players can rejoin a game in progress.
*   **Custom Decks**: Use the default card deck, other included decks, or load your own from any public URL. Decks are loaded from external JSON files.
*   **Easy Integration**: Embed the game into any web-based world with a single script tag, requiring only static hosting.

## Customization

You can customize the game by adding attributes to the `<script>` tag that loads `hah.js`. This is especially useful when embedding the game in platforms like BanterVR.

Here's an example of how you might use it:

```html
<script src="https://your-static-host.com/hah.js"
        position="0 1 -5" 
        rotation="0 90 0" 
        instance="my-private-game" 
        deck="https://gist.githubusercontent.com/someuser/12345/raw/my-deck.json"></script>
```

### Available Attributes

*   `position`: (Default: `"0 0 0"`) Sets the `x y z` position of the game table in the world.
*   `rotation`: (Default: `"0 0 0"`) Sets the `x y z` rotation of the game table.
*   `instance`: (Default: `"demo-game"`) A unique name for the game room. All players with the same instance name will join the same game.
*   `deck`: (Default: `"main"`) Specifies the card deck to use.
    *   **Local Deck**: Use the name of a deck file (without `.json`) located in the `/decks` folder (e.g., `deck="australiadeck"`).
    *   **External Deck**: Provide a full URL to a publicly accessible JSON file that follows the correct deck format.
*   `debug`: (Default: `"false"`) Set to `"true"` to enable extra logging in the browser's developer console.

## Deck Formatting Tool

To make it easier to use custom card decks, this project includes a utility called `formatter.html`. This tool allows you to convert card decks from [CrCast](https://cast.clrtd.com/) (Cards Against Humanity online) into a format compatible with Holograms Against Humanity.

### How to Use `formatter.html`

1.  **Open the Formatter**: Go to the hosted formatter tool at [https://banter-hah.firer.at/formatter.html](https://banter-hah.firer.at/formatter.html) in your web browser.
2.  **Get CrCast Deck Code**:
    *   Go to [CrCast](https://cast.clrtd.com/) to find a deck.
    *   If the deck code doesn't work directly in the formatter, you may need to manually extract the JSON. Use the [API](https://cast.clrtd.com/api) URL and insert the deck code.
    *   Example API URL: `https://api.crcast.cc/v1/cc/decks/CODE/cards/` (replace `CODE` with the actual deck code).
3.  **Paste JSON Data**: Copy the RAW JSON Data (either directly from CrCast if it works, or from the API if manual extraction was needed) and paste it into the input box on the formatter page.
4.  **Format and Copy**: Click the "Format" button. You can then copy the formatted JSON, which is ready to be used with Holograms Against Humanity.
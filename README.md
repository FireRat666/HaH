Holograms Against Humanity
==========================

A terrible game for terrible people, now in your favorite virtual worlds. This is a clone of Cards Against Humanity designed to be easily embedded in social VR platforms like BanterVR.

* Adapted for AltspaceVR by: Derogatory, falkrons, schmidtec
* Ported to Banter by Shane, Improved and ported from Glitch by FireRat

## Features

*   **Multiplayer Fun**: Play with up to 10 players in a single game room.
*   **Player Reconnect**: Disconnected players can rejoin a game in progress.
*   **Custom Decks**: Use the default card deck, other included decks, or load your own from any public URL.
*   **Easy Integration**: Embed the game into any web-based world with a single script tag.
*   **Simple Deployment**: Ready for quick simple deployment on services like Render.

## Local Development

1.  **Prerequisites**: Make sure you have Node.js installed.
2.  **Clone Repository**: Clone this project to your local machine.
3.  **Install Dependencies**: Open a terminal in the project root and run:
    ```bash
    npm install
    ```
4.  **Start Server**: Run the following command to start the local server:
    ```bash
    npm start
    ```
5.  You can now access the game at `http://localhost:3000`.

## Customization

You can customize the game by adding attributes to the `<script>` tag that loads `script.js`. This is especially useful when embedding the game in platforms like BanterVR.

Here's an example of how you might use it:

```html
<script src="https://your-app-name.onrender.com/script.js" 
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
*   `one-for-each-instance`: (Default: `"false"`) A special flag for BanterVR. When set to `"true"`, it automatically creates a unique game for each Banter room instance, preventing players in different rooms from joining the same game.
*   `uid`: (Default: `null`) A unique identifier for a player. If not provided, a random guest ID is generated and stored in the browser's local storage. This attribute is useful for platform integrations (like BanterVR) where the platform can inject a persistent user ID to maintain player identity across sessions.

## Deployment to Render

This application is ready to be deployed on Render.

1.  **Push to GitHub**: Make sure your latest code is pushed to a GitHub repository.
2.  **Create a Web Service on Render**:
    *   In your Render dashboard, click **New +** and select **Web Service**.
    *   Connect your GitHub account and select the repository for this project.
3.  **Configure the Service**:
    *   **Runtime**: Render will auto-detect `Node`.
    *   **Build Command**: `npm install`
    *   **Start Command**: `npm start`
4.  Click **Create Web Service**. Render will build and deploy your app. Once it's live, you can access it at the URL Render provides (e.g., `https://your-app-name.onrender.com`).

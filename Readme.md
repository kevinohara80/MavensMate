# [MavensMate](http://mavensmate.com) - Open Source IDEs for Salesforce1

MavensMate is a powerful open source tool for building Salesforce1 IDEs. Develop Salesforce1 applications in your favorite text editors, like Sublime Text and Atom. MavensMate is created and maintained by [Joe Ferraro](http://twitter.com/joeferraro).

For more information, check out [http://mavensmate.com](http://mavensmate.com)!

**IMPORTANT: the core MavensMate API has undergone a major rewrite for stability and performance. This README is changing rapidly!**

- [MavensMate API](#mavensmate-api)
- [MavensMate Plugins](#active-plugins)
- [Bugs and Feature Requests](#bugs-and-feature-requests)
- [Documentation](#documentation)

[![Circle CI](https://circleci.com/gh/joeferraro/MavensMate.png?style=badge)](https://circleci.com/gh/joeferraro/MavensMate)

## MavensMate API

You can build Salesforce1 IDEs by integrating with the APIs exposed in this project. For Node.js projects, you can simply `require('mavensmate')`. For other types of projects, you may use the command line interface (documentation to come).

### Node.js Projects

To use MavensMate to build a Salesforce1 IDE for your Node.js project:

#### Install

`npm install mavensmate`

#### Usage

```
var mavensmate = require('mavensmate');
var client = mavensmate.createClient({
	editor: '<editor_name>',
	headless: true,
	debugging: true
});
client.setProject('path/to/some/project', function(err, response) {
	client.executeCommand('compile-project', function(err, response) {
		// full list of commands can be found in lib/mavensmate/commands
	});
});
```

#### Run Functional/Unit Tests

`npm test`

## Active Plugins

### [MavensMate for Sublime Text][stp]

MavensMate for Sublime Text is a Sublime Text plugin that uses the `mm` command line tool to provide a rich IDE experience in the editor. The bulk of the MM for ST codebase is used focused on integration with the Sublime Text APIs. The interaction with the Force.com APIs are still handled by `mm`.

**IMPORTANT:** MavensMate for Sublime Text will eventually be ported to use the APIs in this project.

### [MavensMate for Atom (alpha)][atom]

MavensMate for Atom is still in active development.


## Bugs and feature requests

Have a bug or a feature request? If it's specific to the MavensMate core, [please open a new issue](https://github.com/joeferraro/mavensmate/issues). Before opening any issue, please search for existing issues.

If you have an issue with the Sublime Text or Atom plugin specifically, please open an issue at the proper project.

**Always include your MavensMate version number, platform, and specific steps to reproduce.**

## Documentation

MavensMate's documentation is built with [Daux.io](http://daux.io) and publicly available on [http://mavensmate.com][docs].

<img src="http://cdn.mavensconsulting.com/mavensmate/img/mm-bg.jpg"/>

[mmcom]: http://mavensmate.com/?utm_source=github&utm_medium=mavensmate&utm_campaign=api
[docs]: http://mavensmate.com/Getting_Started/Developers
[stp]: https://github.com/joeferraro/MavensMate-SublimeText
[atom]: https://github.com/joeferraro/MavensMate-Atom
[mmgithub]: https://github.com/joeferraro/mm
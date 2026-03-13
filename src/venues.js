/**
 * Shared venue coordinate map for NYC venues and parks.
 * Used by all sources (RA, Skint, Nonsense NYC, Oh My Rockness, Tavily, NYC Parks)
 * to resolve venue names → lat/lng when structured geo data is missing.
 */

const VENUE_MAP = {
  // === Bushwick / East Williamsburg ===
  'Nowadays': { lat: 40.7061, lng: -73.9212 },
  'Elsewhere': { lat: 40.7013, lng: -73.9225 },
  'Knockdown Center': { lat: 40.7150, lng: -73.9135 },
  'Brooklyn Mirage': { lat: 40.7060, lng: -73.9225 },
  'Avant Gardner': { lat: 40.7060, lng: -73.9225 },
  'The Brooklyn Mirage': { lat: 40.7060, lng: -73.9225 },
  'Jupiter Disco': { lat: 40.7013, lng: -73.9207 },
  'Bossa Nova Civic Club': { lat: 40.7065, lng: -73.9214 },
  'House of Yes': { lat: 40.7048, lng: -73.9230 },
  'Mood Ring': { lat: 40.7053, lng: -73.9211 },
  'Market Hotel': { lat: 40.7058, lng: -73.9216 },
  'Sustain': { lat: 40.7028, lng: -73.9273 },
  'H0L0': { lat: 40.7087, lng: -73.9246 },
  'Rubulad': { lat: 40.6960, lng: -73.9270 },
  'The Sultan Room': { lat: 40.7058, lng: -73.9216 },
  'The Meadows': { lat: 40.7058, lng: -73.9216 },
  'Signal': { lat: 40.7058, lng: -73.9216 },
  'Outer Heaven': { lat: 40.7058, lng: -73.9216 },
  'Pine Box Rock Shop': { lat: 40.7054, lng: -73.9216 },
  'Cobra Club': { lat: 40.7055, lng: -73.9234 },
  'Eris Main Stage': { lat: 40.7135, lng: -73.9438 },
  'Eris': { lat: 40.7135, lng: -73.9438 },
  'TV Eye': { lat: 40.7036, lng: -73.9099 },

  // === Williamsburg ===
  'Baby\'s All Right': { lat: 40.7095, lng: -73.9591 },
  'Mansions': { lat: 40.7112, lng: -73.9565 },
  'Superior Ingredients': { lat: 40.7119, lng: -73.9538 },
  'Purgatory': { lat: 40.7099, lng: -73.9428 },
  'Schimanski': { lat: 40.7115, lng: -73.9618 },
  'Rumi': { lat: 40.7243, lng: -73.9543 },
  'Brooklyn Steel': { lat: 40.7115, lng: -73.9505 },
  'Brooklyn Bowl': { lat: 40.7223, lng: -73.9510 },
  'Rough Trade NYC': { lat: 40.7220, lng: -73.9508 },
  'Music Hall of Williamsburg': { lat: 40.7111, lng: -73.9607 },
  'National Sawdust': { lat: 40.7116, lng: -73.9625 },
  'Pete\'s Candy Store': { lat: 40.7126, lng: -73.9558 },
  'Knitting Factory Brooklyn': { lat: 40.7112, lng: -73.9604 },
  'Sleepwalk': { lat: 40.7130, lng: -73.9608 },
  'Wythe Hotel': { lat: 40.7220, lng: -73.9578 },
  'Moxy Williamsburg': { lat: 40.7140, lng: -73.9610 },
  'Marche Rue Dix': { lat: 40.6898, lng: -73.9502 },

  // === Greenpoint ===
  'McCarren Parkhouse': { lat: 40.7206, lng: -73.9515 },
  'Good Room': { lat: 40.7268, lng: -73.9516 },
  'Lot Radio': { lat: 40.7116, lng: -73.9383 },
  'The Lot Radio': { lat: 40.7116, lng: -73.9383 },
  'Warsaw': { lat: 40.7291, lng: -73.9510 },
  'Saint Vitus': { lat: 40.7274, lng: -73.9528 },
  'Good Judy': { lat: 40.7301, lng: -73.9518 },
  'Greenpoint Terminal Market': { lat: 40.7360, lng: -73.9580 },
  'The Springs': { lat: 40.7240, lng: -73.9500 },
  'Archestratus': { lat: 40.7281, lng: -73.9505 },
  'Le Gamin': { lat: 40.7299, lng: -73.9523 },
  'Palace Cafe': { lat: 40.7287, lng: -73.9520 },
  'Troost': { lat: 40.7270, lng: -73.9499 },

  // === Bed-Stuy ===
  'Ode to Babel': { lat: 40.6870, lng: -73.9440 },
  'Lovers Rock': { lat: 40.6863, lng: -73.9523 },
  'Bed-Vyne Brew': { lat: 40.6880, lng: -73.9480 },
  'Saraghina': { lat: 40.6870, lng: -73.9350 },
  'Do or Dive': { lat: 40.6890, lng: -73.9530 },
  'Dynaco': { lat: 40.6873, lng: -73.9495 },
  'Therapy Wine Bar': { lat: 40.6868, lng: -73.9387 },
  'Casablanca Cocktail Lounge': { lat: 40.6876, lng: -73.9513 },
  'Peaches HotHouse': { lat: 40.6886, lng: -73.9487 },
  'C\'mon Everybody': { lat: 40.6883, lng: -73.9535 },
  'Loudmouth': { lat: 40.6810, lng: -73.9437 },

  // === Upper West Side ===
  'Beacon Theatre': { lat: 40.7805, lng: -73.9812 },
  'Symphony Space': { lat: 40.7849, lng: -73.9791 },
  'Smoke Jazz Club': { lat: 40.8020, lng: -73.9680 },
  'Lincoln Center': { lat: 40.7725, lng: -73.9835 },
  'Jazz at Lincoln Center': { lat: 40.7686, lng: -73.9832 },
  'Lincoln Center Presents': { lat: 40.7725, lng: -73.9835 },
  'Film Society of Lincoln Center': { lat: 40.7725, lng: -73.9835 },
  'The New York Public Library for the Performing Arts': { lat: 40.7730, lng: -73.9837 },
  'Chamber Music Society of Lincoln Center': { lat: 40.7725, lng: -73.9835 },
  'The Triad': { lat: 40.7805, lng: -73.9810 },
  'Gin Mill': { lat: 40.7834, lng: -73.9787 },
  'George Keeley': { lat: 40.7840, lng: -73.9786 },
  'New York Public Library - Morningside Heights Branch': { lat: 40.8063, lng: -73.9625 },

  // === West Village / Greenwich Village ===
  '154 Christopher St': { lat: 40.7331, lng: -74.0045 },
  'The New School\'s College of Performing Arts': { lat: 40.7361, lng: -73.9955 },
  'Smalls Jazz Club': { lat: 40.7346, lng: -74.0027 },
  'Village Vanguard': { lat: 40.7360, lng: -74.0010 },
  'Comedy Cellar': { lat: 40.7304, lng: -74.0003 },
  'Blue Note': { lat: 40.7310, lng: -74.0001 },
  'IFC Center': { lat: 40.7340, lng: -74.0003 },
  'Fat Cat': { lat: 40.7383, lng: -74.0022 },
  'The Bitter End': { lat: 40.7296, lng: -73.9980 },
  'Cafe Wha?': { lat: 40.7299, lng: -74.0002 },
  'Groove': { lat: 40.7336, lng: -74.0010 },
  'Terra Blues': { lat: 40.7299, lng: -73.9976 },
  '(Le) Poisson Rouge': { lat: 40.7296, lng: -73.9993 },
  'Le Poisson Rouge': { lat: 40.7296, lng: -73.9993 },
  'Zinc Bar': { lat: 40.7290, lng: -73.9979 },
  'Mezzrow': { lat: 40.7346, lng: -74.0027 },
  'The Stonewall Inn': { lat: 40.7338, lng: -74.0020 },

  // === Chelsea / Meatpacking ===
  'Le Bain': { lat: 40.7408, lng: -74.0078 },
  'Cielo': { lat: 40.7410, lng: -74.0056 },
  'Marquee': { lat: 40.7475, lng: -74.0010 },

  // === Lower East Side ===
  'Mercury Lounge': { lat: 40.7219, lng: -73.9866 },
  'Rockwood Music Hall': { lat: 40.7229, lng: -73.9897 },
  'Arlene\'s Grocery': { lat: 40.7207, lng: -73.9884 },
  'The Back Room': { lat: 40.7186, lng: -73.9864 },
  'Pianos': { lat: 40.7207, lng: -73.9881 },

  // === East Village ===
  'Webster Hall': { lat: 40.7318, lng: -73.9897 },
  'The Parkside Lounge': { lat: 40.7228, lng: -73.9845 },
  'Nublu': { lat: 40.7241, lng: -73.9818 },
  'Drom': { lat: 40.7250, lng: -73.9838 },
  'Tompkins Square Park': { lat: 40.7265, lng: -73.9817 },
  'Niagara': { lat: 40.7249, lng: -73.9829 },
  'Club Cumming': { lat: 40.7233, lng: -73.9849 },
  'Village East by Angelika': { lat: 40.7313, lng: -73.9874 },
  'New York Public Library, Tompkins Square Branch': { lat: 40.7270, lng: -73.9810 },
  'The Alchemist\'s Kitchen Elixir Bar': { lat: 40.7245, lng: -73.9914 },

  // === East Village (continued) ===
  'Pangea': { lat: 40.7249, lng: -73.9840 },

  // === Flatiron / Union Square ===
  'Center for Jewish History': { lat: 40.7383, lng: -73.9931 },
  'Green Room NYC': { lat: 40.7424, lng: -73.9927 },
  'Paragon': { lat: 40.7187, lng: -73.9904 },
  'Irving Plaza': { lat: 40.7349, lng: -73.9882 },
  'Gramercy Theatre': { lat: 40.7348, lng: -73.9863 },
  'New York Comedy Club': { lat: 40.7394, lng: -73.9819 },
  'People\'s Improv Theater': { lat: 40.7400, lng: -73.9849 },

  // === SoHo / NoHo ===
  'Joe\'s Pub': { lat: 40.7290, lng: -73.9913 },
  'SOB\'s': { lat: 40.7258, lng: -74.0053 },
  'Arlo Hotel Soho': { lat: 40.7265, lng: -74.0073 },

  // === Midtown / Hell\'s Kitchen ===
  'Terminal 5': { lat: 40.7690, lng: -73.9930 },
  'Carnegie Hall': { lat: 40.7651, lng: -73.9799 },
  'Radio City Music Hall': { lat: 40.7600, lng: -73.9800 },
  'Town Hall': { lat: 40.7574, lng: -73.9860 },
  'The Cutting Room': { lat: 40.7477, lng: -73.9826 },
  'Madison Square Garden': { lat: 40.7505, lng: -73.9934 },
  'New York Comedy Club Midtown': { lat: 40.7638, lng: -73.9882 },
  'Arlo Hotel Midtown': { lat: 40.7562, lng: -73.9931 },
  'VERSA': { lat: 40.7495, lng: -73.9913 },
  'Pershing Square': { lat: 40.7520, lng: -73.9774 },
  'Brooklyn Delicatessen Times Square': { lat: 40.7580, lng: -73.9855 },
  'Sheraton New York Times Square Hotel': { lat: 40.7625, lng: -73.9820 },

  // === Cobble Hill / Brooklyn Heights / Boerum Hill ===
  'Jalopy Theatre': { lat: 40.6771, lng: -74.0012 },
  '61 Local': { lat: 40.6847, lng: -73.9955 },
  'Henry Public': { lat: 40.6880, lng: -73.9940 },
  'Floyd': { lat: 40.6860, lng: -73.9930 },
  'St. Ann\'s Warehouse': { lat: 40.7010, lng: -73.9930 },
  'St. Ann & the Holy Trinity Church': { lat: 40.6930, lng: -73.9943 },

  // === Fort Greene / Clinton Hill ===
  'BAM': { lat: 40.6861, lng: -73.9781 },
  'BAM Howard Gilman Opera House': { lat: 40.6861, lng: -73.9781 },
  'BAM, Howard Gilman Opera House': { lat: 40.6861, lng: -73.9781 },
  'BAM Harvey Theater': { lat: 40.6877, lng: -73.9761 },
  'BRIC': { lat: 40.6865, lng: -73.9772 },
  'BRIC House Media Center': { lat: 40.6865, lng: -73.9772 },
  'BRIC House': { lat: 40.6865, lng: -73.9772 },

  // === Prospect Heights / Crown Heights ===
  'Brooklyn Museum': { lat: 40.6712, lng: -73.9636 },
  'Brooklyn Botanic Garden': { lat: 40.6694, lng: -73.9625 },

  // === Gowanus / Park Slope ===
  'The Bell House': { lat: 40.6738, lng: -73.9905 },
  'Union Hall': { lat: 40.6741, lng: -73.9789 },
  'Barbes': { lat: 40.6727, lng: -73.9789 },
  'Littlefield': { lat: 40.6729, lng: -73.9897 },

  // === Red Hook ===
  'Pioneer Works': { lat: 40.6785, lng: -74.0138 },
  'Sunny\'s Bar': { lat: 40.6771, lng: -74.0098 },

  // === DUMBO ===
  'Basement': { lat: 40.7127, lng: -73.9570 },
  'Brooklyn Hangar': { lat: 40.6780, lng: -73.9980 },

  // === Sunset Park ===
  'Industry City': { lat: 40.6553, lng: -74.0069 },
  'The Green-Wood Cemetery': { lat: 40.6584, lng: -73.9944 },
  'Green-Wood Cemetery': { lat: 40.6584, lng: -73.9944 },
  'Sunset Park Recreation Center': { lat: 40.6462, lng: -74.0024 },

  // === Downtown Brooklyn ===
  'Public Records': { lat: 40.6807, lng: -73.9576 },
  'Quantum Brooklyn': { lat: 40.6888, lng: -73.9785 },
  'Under the K Bridge Park': { lat: 40.7032, lng: -73.9887 },

  // === Harlem ===
  'Apollo Theater': { lat: 40.8099, lng: -73.9500 },
  'Silvana': { lat: 40.8097, lng: -73.9497 },
  'Shrine': { lat: 40.8138, lng: -73.9515 },
  'Minton\'s Playhouse': { lat: 40.8089, lng: -73.9469 },
  'Native Harlem': { lat: 40.8046, lng: -73.9502 },
  'NYPL - Hamilton Grange Library': { lat: 40.8237, lng: -73.9476 },

  // === Washington Heights ===
  'United Palace': { lat: 40.8399, lng: -73.9395 },

  // === Astoria ===
  'QED Astoria': { lat: 40.7713, lng: -73.9318 },
  'Bohemian Hall & Beer Garden': { lat: 40.7624, lng: -73.9186 },
  'FD Photo Studio Astoria': { lat: 40.7700, lng: -73.9230 },

  // === Long Island City ===
  'MoMA PS1': { lat: 40.7454, lng: -73.9471 },
  'Culture Lab LIC': { lat: 40.7440, lng: -73.9485 },

  // === NYC Parks — Manhattan ===
  'Central Park': { lat: 40.7812, lng: -73.9665 },
  'Washington Square Park': { lat: 40.7308, lng: -73.9973 },
  'Bryant Park': { lat: 40.7536, lng: -73.9832 },
  'Union Square Park': { lat: 40.7359, lng: -73.9911 },
  'Madison Square Park': { lat: 40.7425, lng: -73.9882 },
  'Riverside Park': { lat: 40.8030, lng: -73.9712 },
  'Morningside Park': { lat: 40.8044, lng: -73.9582 },
  'Marcus Garvey Park': { lat: 40.8041, lng: -73.9440 },
  'St. Nicholas Park': { lat: 40.8190, lng: -73.9499 },
  'Fort Tryon Park': { lat: 40.8621, lng: -73.9314 },
  'Highbridge Park': { lat: 40.8417, lng: -73.9320 },
  'Battery Park': { lat: 40.7033, lng: -74.0170 },
  'Hudson River Park': { lat: 40.7270, lng: -74.0115 },
  'East River Park': { lat: 40.7131, lng: -73.9755 },
  'Stuyvesant Square': { lat: 40.7338, lng: -73.9840 },
  'DeWitt Clinton Park': { lat: 40.7664, lng: -73.9942 },
  'Inwood Hill Park': { lat: 40.8680, lng: -73.9270 },
  'Andrew Haswell Green Park': { lat: 40.7690, lng: -73.9520 },
  'Sara D. Roosevelt Park': { lat: 40.7188, lng: -73.9935 },
  'Carl Schurz Park': { lat: 40.7756, lng: -73.9441 },
  'Pier 35': { lat: 40.7110, lng: -73.9830 },
  'Pier 26': { lat: 40.7215, lng: -74.0120 },

  // === NYC Parks — Brooklyn ===
  'Prospect Park': { lat: 40.6602, lng: -73.9690 },
  'McCarren Park': { lat: 40.7206, lng: -73.9515 },
  'Fort Greene Park': { lat: 40.6895, lng: -73.9762 },
  'Fort Greene Park Visitor Center': { lat: 40.6895, lng: -73.9762 },
  'Maria Hernandez Park': { lat: 40.7032, lng: -73.9239 },
  'Herbert Von King Park': { lat: 40.6881, lng: -73.9440 },
  'Domino Park': { lat: 40.7171, lng: -73.9664 },
  'Sunset Park': { lat: 40.6462, lng: -74.0024 },
  'Red Hook Recreation Area': { lat: 40.6730, lng: -74.0060 },
  'Brower Park': { lat: 40.6722, lng: -73.9592 },
  'Cadman Plaza Park': { lat: 40.6955, lng: -73.9930 },
  'Coffey Park': { lat: 40.6762, lng: -74.0100 },
  'Monsignor McGolrick Park': { lat: 40.7240, lng: -73.9420 },
  'Owl\'s Head Park': { lat: 40.6438, lng: -74.0280 },
  'Owl\'s Head Park House': { lat: 40.6438, lng: -74.0280 },
  'Leif Ericson Park': { lat: 40.6382, lng: -74.0300 },
  'Betsy Head Park': { lat: 40.6627, lng: -73.9134 },
  'Canarsie Park House': { lat: 40.6350, lng: -73.8920 },

  // === NYC Parks — Queens ===
  'Astoria Park': { lat: 40.7750, lng: -73.9240 },
  'Socrates Sculpture Park': { lat: 40.7684, lng: -73.9388 },
  'Gantry Plaza State Park': { lat: 40.7471, lng: -73.9586 },
  'Flushing Meadows Corona Park': { lat: 40.7400, lng: -73.8408 },
  'Juniper Valley Park': { lat: 40.7208, lng: -73.8828 },
  'Kissena Park': { lat: 40.7510, lng: -73.8130 },

  // === NYC Parks — Bronx ===
  'St. Mary\'s Park': { lat: 40.8090, lng: -73.9145 },
  'Crotona Park': { lat: 40.8389, lng: -73.8944 },

  // === NYC Parks — Facilities & Nature Centers ===
  'Greenbelt Nature Center': { lat: 40.5930, lng: -74.1460 },
  'Salt Marsh Nature Center': { lat: 40.6053, lng: -73.9298 },
  'Wave Hill': { lat: 40.8975, lng: -73.9115 },

  // === NYC Parks — Additional Parks ===
  'The High Line': { lat: 40.7480, lng: -74.0048 },
  'Brooklyn Bridge Park': { lat: 40.7002, lng: -73.9965 },
  'Pier 6': { lat: 40.6918, lng: -73.9993 },
  'McKinley Park': { lat: 40.6540, lng: -74.0068 },
  'Cunningham Park': { lat: 40.7350, lng: -73.7680 },
  'Queensbridge Park': { lat: 40.7562, lng: -73.9450 },
  'Oak Ridge': { lat: 40.7010, lng: -73.8442 },
  'Conference House Park': { lat: 40.5000, lng: -74.2360 },
  'Henry Hudson Park': { lat: 40.8780, lng: -73.9210 },
  'Marine Park': { lat: 40.5930, lng: -73.9200 },

  // === Cultural Venues — Film ===
  'Metrograph': { lat: 40.7144, lng: -73.9879 },
  'Film Forum': { lat: 40.7284, lng: -74.0044 },
  'Film at Lincoln Center': { lat: 40.7725, lng: -73.9835 },
  'Nitehawk Cinema': { lat: 40.7160, lng: -73.9626 },
  'Nitehawk Cinema Williamsburg': { lat: 40.7160, lng: -73.9626 },
  'Nitehawk Prospect Park': { lat: 40.6613, lng: -73.9797 },
  'Anthology Film Archives': { lat: 40.7248, lng: -73.9903 },
  'BAM Rose Cinemas': { lat: 40.6867, lng: -73.9775 },
  'Spectacle Theater': { lat: 40.7125, lng: -73.9629 },
  'Alamo Drafthouse': { lat: 40.6866, lng: -73.9818 },
  'Alamo Drafthouse Downtown Brooklyn': { lat: 40.6866, lng: -73.9818 },
  'Stuart Cinema & Cafe': { lat: 40.7292, lng: -73.9594 },
  'Roxy Cinema': { lat: 40.7199, lng: -74.0086 },
  'The Roxy Cinema': { lat: 40.7199, lng: -74.0086 },
  'Paris Theater': { lat: 40.7642, lng: -73.9726 },
  'The Paris Theater': { lat: 40.7642, lng: -73.9726 },

  // === Comedy Venues ===
  'The Tiny Cupboard': { lat: 40.6878, lng: -73.9181 },
  'Brooklyn Comedy Collective': { lat: 40.7109, lng: -73.9445 },

  // === Cultural Venues — Bookstores & Literary ===
  'Greenlight Bookstore': { lat: 40.6862, lng: -73.9746 },
  'Greenlight Bookstore Fort Greene': { lat: 40.6862, lng: -73.9746 },
  'Books Are Magic': { lat: 40.6858, lng: -73.9940 },
  'Strand Book Store': { lat: 40.7333, lng: -73.9910 },
  'Strand Bookstore': { lat: 40.7333, lng: -73.9910 },
  'McNally Jackson': { lat: 40.7234, lng: -73.9959 },
  'McNally Jackson Books': { lat: 40.7234, lng: -73.9959 },
  'Housing Works Bookstore': { lat: 40.7255, lng: -73.9975 },
  'Housing Works Bookstore Cafe': { lat: 40.7255, lng: -73.9975 },
  'The Center for Fiction': { lat: 40.6886, lng: -73.9793 },
  'Powerhouse Arena': { lat: 40.7033, lng: -73.9891 },
  'P&T Knitwear': { lat: 40.7219, lng: -73.9882 },
  'Liz\'s Book Bar': { lat: 40.6812, lng: -73.9941 },
  'Book Club Bar': { lat: 40.7230, lng: -73.9832 },
  'Hive Mind Books': { lat: 40.7010, lng: -73.9175 },
  'Everyone Comics & Books': { lat: 40.7513, lng: -73.9391 },

  // === Cultural Venues — Art & Museums ===
  'New Museum': { lat: 40.7224, lng: -73.9930 },
  'The Shed': { lat: 40.7538, lng: -74.0022 },
  'Abrons Arts Center': { lat: 40.7153, lng: -73.9838 },
  'Museum of the Moving Image': { lat: 40.7563, lng: -73.9239 },
  'The Africa Center': { lat: 40.7964, lng: -73.9488 },
  'El Museo del Barrio': { lat: 40.7931, lng: -73.9514 },
  'Museum of Chinese in America': { lat: 40.7194, lng: -73.9991 },
  'Schomburg Center': { lat: 40.8147, lng: -73.9405 },
  'Schomburg Center for Research in Black Culture': { lat: 40.8147, lng: -73.9405 },
  'Ki Smith Gallery': { lat: 40.7212, lng: -73.9912 },
  'Soho Photo Gallery': { lat: 40.7186, lng: -74.0056 },
  'The National Arts Club': { lat: 40.7377, lng: -73.9867 },
  'Museum of Arts and Design': { lat: 40.7695, lng: -73.9848 },
  'The Paley Center for Media': { lat: 40.7607, lng: -73.9778 },

  // === Cultural Venues — Music & Performance ===
  'Roulette': { lat: 40.6888, lng: -73.9786 },
  'Issue Project Room': { lat: 40.6837, lng: -73.9796 },
  'Jazz Gallery': { lat: 40.7446, lng: -73.9886 },
  'The Kitchen': { lat: 40.7424, lng: -73.9985 },
  'Greenwich House Music School': { lat: 40.7322, lng: -74.0046 },
  'David Geffen Hall': { lat: 40.7723, lng: -73.9830 },
  'David Geffen Hall, Lincoln Center': { lat: 40.7723, lng: -73.9830 },
  'New York Live Arts': { lat: 40.7421, lng: -73.9983 },
  'Nuyorican Poets Cafe': { lat: 40.7219, lng: -73.9818 },
  'Brooklyn Music Kitchen': { lat: 40.6926, lng: -73.9695 },
  'BKCM': { lat: 40.6786, lng: -73.9721 },
  'Brooklyn Conservatory of Music': { lat: 40.6786, lng: -73.9721 },
  'New York City Center': { lat: 40.7638, lng: -73.9795 },
  'Barclays Center': { lat: 40.6827, lng: -73.9753 },
  'Kings Theatre': { lat: 40.6460, lng: -73.9580 },

  // === Cultural Venues — Yutori Recurring ===
  'BAM (Brooklyn Academy of Music)': { lat: 40.6861, lng: -73.9781 },
  'Fritz': { lat: 40.6870, lng: -73.9750 },
  'Friends and Lovers': { lat: 40.6747, lng: -73.9610 },
  'Friends & Lovers': { lat: 40.6747, lng: -73.9610 },
  'Singers': { lat: 40.6895, lng: -73.9515 },
  'Salon on Kingston': { lat: 40.6750, lng: -73.9475 },
  'Brooklyn Community Pride Center': { lat: 40.6822, lng: -73.9567 },

  // === Cultural Venues — Nonsense NYC Recurring ===
  'Fabrik Dumbo': { lat: 40.7036, lng: -73.9870 },
  'Fabrik': { lat: 40.7036, lng: -73.9870 },
  'The Sailboat': { lat: 40.7087, lng: -73.9246 },
  'Studios 797': { lat: 40.7440, lng: -73.9485 },

  // === Venues added for neighborhood resolution gap (#19) ===

  // Bowery / Nolita
  'Silence Please': { lat: 40.7189, lng: -73.9949 },

  // Chinatown / LES
  '36 E Broadway': { lat: 40.7141, lng: -73.9893 },
  'P.S. 130 Hernando De Soto': { lat: 40.7170, lng: -73.9990 },

  // Chelsea
  'Bar Bonobo': { lat: 40.7431, lng: -74.0000 },

  // NoMad / Gramercy
  'Tavern 29': { lat: 40.7443, lng: -73.9840 },

  // TriBeCa
  'Farm.One': { lat: 40.7181, lng: -74.0074 },

  // East Williamsburg / Bushwick
  'Moondog Hifi': { lat: 40.7079, lng: -73.9292 },
  'SILO': { lat: 40.7106, lng: -73.9227 },

  // Williamsburg
  'Cargo @ Dead Letter No. 9': { lat: 40.7145, lng: -73.9673 },
  'Brooklyn Comedy Collective': { lat: 40.7072, lng: -73.9411 },
  'The Brooklyn Comedy Collective': { lat: 40.7072, lng: -73.9411 },

  // Crown Heights / Prospect Heights
  'Kvartira Books': { lat: 40.6750, lng: -73.9629 },

  // Sheepshead Bay
  'Brooklyn Public Library - Kings Highway Branch': { lat: 40.6103, lng: -73.9531 },

  // Rockaway
  'Rockaway Botanica': { lat: 40.5836, lng: -73.8161 },

  // Staten Island
  'St. George Theatre': { lat: 40.6420, lng: -74.0775 },
  'H.H. Biddle House': { lat: 40.5035, lng: -74.2515 },

  // Queens — LIC / Queensbridge
  'Queensbridge Park House': { lat: 40.7565, lng: -73.9486 },

  // Queens — Sunnyside
  '43rd Street & Skillman Avenue': { lat: 40.7469, lng: -73.9212 },

  // Queens — Bayside
  'Commonpoint Queens - Bay Terrace Center': { lat: 40.7851, lng: -73.7793 },
  'Commonpoint Queens Bay Terrace Center': { lat: 40.7851, lng: -73.7793 },

  // Queens — Fort Totten / Bayside
  'Fort Totten Park Visitors Center': { lat: 40.7924, lng: -73.7881 },

  // Bronx — Mott Haven
  'Pregones Theater': { lat: 40.8196, lng: -73.9283 },

  // Bronx — Van Cortlandt
  'Broadway and Mosholu Avenue': { lat: 40.8982, lng: -73.9036 },

  // Queens — East Elmhurst
  'PS 329Q - East Elmhurst Community School': { lat: 40.7633, lng: -73.8697 },

  // Queens — Jamaica
  'Rochdale Village Community Center': { lat: 40.6770, lng: -73.7660 },

  // Bronx — Hunts Point
  'Graham Hunts Point Beacon Community Center': { lat: 40.8181, lng: -73.8925 },

  // Bronx — Pelham Bay
  'Bartow Community Center - Room 31': { lat: 40.8722, lng: -73.8038 },

  // Manhattan — Midtown East
  'Ralph Bunche Park': { lat: 40.7492, lng: -73.9695 },

  // Manhattan — Chelsea
  'Hudson Guild Fulton Community Center': { lat: 40.7440, lng: -74.0006 },

  // Manhattan — Inwood
  'West 218th Street and Indian Road': { lat: 40.8693, lng: -73.9247 },

  // Manhattan — Harlem
  'NYPL - Countee Cullen Library': { lat: 40.8147, lng: -73.9405 },

  // Brooklyn — Flatlands
  'Christian Cultural Center - Brooklyn Campus': { lat: 40.6250, lng: -73.9040 },

  // Brooklyn — Flatbush
  'Fit4Dance NYC': { lat: 40.6518, lng: -73.9581 },

  // Brooklyn — Williamsburg
  'Old Man Hustle BKLYN COMEDY Club': { lat: 40.7138, lng: -73.9617 },

  // Queens — LIC
  'Queens Public Library - Broadway': { lat: 40.7620, lng: -73.9250 },
  'Queens Public Library - East Elmhurst': { lat: 40.7636, lng: -73.8680 },

  // Queens — Bayside
  'Queens Public Library - Bayside': { lat: 40.7688, lng: -73.7710 },

  // Brooklyn — Mill Basin
  'Brooklyn Public Library - Mill Basin': { lat: 40.6060, lng: -73.9090 },

  // Bronx — Eastchester
  'NYPL - Eastchester Library': { lat: 40.8769, lng: -73.8301 },

  // Staten Island — Willowbrook
  'Greenbelt Native Plant Center': { lat: 40.5930, lng: -74.1460 },

  // LES / Chinatown
  'Basement Chinatown': { lat: 40.7150, lng: -73.9975 },

  // === NYC Parks facilities — generic names with known locations ===
  '102nd Street Field House': { lat: 40.7951, lng: -73.9695 },
  'Entrance - West 77th Street and Central Park West': { lat: 40.7807, lng: -73.9741 },
  'Parade Start: Mott and Canal': { lat: 40.7182, lng: -73.9979 },
  'Stuyvesant Square - east fountain': { lat: 40.7335, lng: -73.9837 },
  'Eton Place Parking Lot': { lat: 40.6009, lng: -74.1583 },
  'Cunningham Park Parking Lot': { lat: 40.7359, lng: -73.7687 },
  'Golden Age Classroom A': { lat: 40.6564, lng: -73.9299 },
  'Multipurpose Room': { lat: 40.6895, lng: -73.9762 },
  'Athletic Courts': { lat: 40.6895, lng: -73.9762 },
};

/**
 * Venue size classification for community scoring.
 * Four tiers: intimate (<~100), medium (~100-500), large (~500-1500), massive (1500+).
 * Only venues we actually see events at need classification.
 * Unclassified venues get null (neutral in community score).
 */
const VENUE_SIZE = {
  // === Intimate (<~100 capacity) — bars, small clubs, DIY spaces ===

  // Jazz clubs
  'Smalls Jazz Club': 'intimate',
  'Mezzrow': 'intimate',
  'Bar Bayeux': 'intimate',
  'Cellar Dog': 'intimate',
  'BrownstoneJAZZ': 'intimate',

  // Bushwick / East Williamsburg small venues
  'The Tiny Cupboard': 'intimate',
  'Mood Ring': 'intimate',
  'Jupiter Disco': 'intimate',
  'H0L0': 'intimate',
  'Signal': 'intimate',
  'Cobra Club': 'intimate',
  'Pine Box Rock Shop': 'intimate',
  'Outer Heaven': 'intimate',
  'Sustain': 'intimate',
  'Market Hotel': 'intimate',
  'Moondog Hifi': 'intimate',
  'ALPHAVILLE': 'intimate',
  'Xanadu': 'intimate',

  // Williamsburg / Greenpoint small venues
  'Pete\'s Candy Store': 'intimate',
  'Mansions': 'intimate',
  'Superior Ingredients': 'intimate',
  'Purgatory': 'intimate',
  'Sleepwalk': 'intimate',
  'Cassette': 'intimate',
  'Reforesters Laboratory': 'intimate',

  // East Village / LES small venues
  'Berlin': 'intimate',
  'Nublu 151': 'intimate',
  'Nublu': 'intimate',
  'DROM': 'intimate',
  'Lucinda\'s': 'intimate',
  'Night Club 101': 'intimate',
  'Terra Blues': 'intimate',
  'Pianos': 'intimate',
  'Pianos: Showroom': 'intimate',
  'Pianos: The Mezzanine': 'intimate',
  'Arlene\'s Grocery': 'intimate',

  // Other intimate venues
  'Cafe Wha?': 'intimate',
  'Madame X': 'intimate',
  'Don\'t Tell Mama': 'intimate',
  'Silver Lining Lounge': 'intimate',
  'Index Chinatown': 'intimate',
  'Silence Please': 'intimate',
  'Shrine': 'intimate',
  'Iridium': 'intimate',
  'Brooklyn Music Kitchen': 'intimate',

  // Comedy clubs (small rooms)
  'Brooklyn Comedy Collective': 'intimate',
  'The PIT Loft': 'intimate',
  'Eastville Comedy Club': 'intimate',
  'St. Marks Comedy Club': 'intimate',
  'Comic Strip Live NYC': 'intimate',
  'Gotham Comedy Club': 'intimate',
  'New York Comedy Club Midtown': 'intimate',
  'NEW YORK COMEDY CLUB EAST VILLAGE': 'intimate',
  'New York Comedy Club Upper West Side': 'intimate',
  'People\'s Improv Theater': 'intimate',
  'Eris Deep Space': 'intimate',
  'Eris Mainstage': 'intimate',
  'Eris Main Stage': 'intimate',
  'Eris': 'intimate',
  'Upright Citizens Brigade Theatre': 'intimate',

  // Cultural / community intimate spaces
  'Nuyorican Poets Cafe': 'intimate',
  'Caveat': 'intimate',
  'Greenlight Bookstore in Fort Greene': 'intimate',
  'Metrograph': 'intimate',
  'IFC Center': 'intimate',
  'Roulette': 'intimate',
  'Issue Project Room': 'intimate',
  'Jazz Gallery': 'intimate',
  'The Kitchen': 'intimate',
  'Greenwich House Music School': 'intimate',
  'Fabrik DUMBO': 'intimate',
  'Fabrik Dumbo': 'intimate',
  'Fabrik': 'intimate',
  'Fabrik NYC': 'intimate',

  // Bars (trivia / community hosts)
  'Keg & Lantern Brewing': 'intimate',
  'Brooklyn Brewery': 'intimate',
  'Gowanus Gardens': 'intimate',
  'The Vale Public House': 'intimate',

  // Ridgewood
  'TV Eye': 'intimate',
  'SILO': 'intimate',

  // === Medium (~100-500 capacity) ===

  // Music venues
  'Baby\'s All Right': 'medium',
  'Bossa Nova Civic Club': 'medium',
  'House of Yes': 'medium',
  'The Sultan Room': 'medium',
  'C\'mon Everybody': 'medium',
  'Le Poisson Rouge': 'medium',
  'Mercury Lounge': 'medium',
  'Bowery Palace': 'medium',
  'SOBs': 'medium',
  'Union Pool': 'medium',
  'Racket NYC': 'medium',
  'public records': 'medium',
  'Nowadays': 'medium',
  'Littlefield': 'medium',
  'Nebula': 'medium',
  'Eden': 'medium',
  'Le Bain': 'medium',

  // Comedy / theater (medium rooms)
  'The Stand': 'medium',
  'Joe\'s Pub': 'medium',
  'The Bell House': 'medium',
  'The Theater Center': 'medium',

  // Brooklyn cultural
  'BRIC House Media Center': 'medium',
  'National Sawdust': 'medium',
  'New York Live Arts': 'medium',

  // Art / activity
  'Muse Paintbar - Tribeca': 'medium',
  'The Crafty Lounge': 'medium',
  'Seventh Heaven Bar & Karaoke': 'medium',
  'The Red Pavilion': 'medium',

  // === Large (~500-1500 capacity) ===

  // Concert halls
  'Brooklyn Steel': 'large',
  'Webster Hall': 'large',
  'Irving Plaza': 'large',
  'Music Hall of Williamsburg': 'large',
  'Brooklyn Bowl': 'large',
  'Bowery Ballroom': 'large',
  'Gramercy Theatre': 'large',
  'The Gramercy Theatre': 'large',
  'Warsaw': 'large',
  'Marquee New York': 'large',
  'City Winery': 'large',

  // Elsewhere (multi-room — main room is large)
  'Elsewhere': 'large',

  // Clubs
  'Knockdown Center': 'large',

  // Performing arts
  'BAM': 'large',
  'The Shed': 'large',
  'The Shed at Hudson Yards': 'large',
  'The Griffin Theater - The Shed': 'large',
  'Blue Note Jazz Club': 'large',
  'Birdland Jazz Club': 'large',
  'Birdland Theater': 'large',
  'Lincoln Center Theater': 'large',
  'Lincoln Center - Claire Tow Theater': 'medium',
  'New York City Center': 'large',
  'David Geffen Hall': 'large',

  // Off-Broadway
  'New World Stages - Stage 1': 'large',
  'New World Stages - Stage 2': 'large',
  'New World Stages - Stage 3': 'large',
  'New World Stages - Stage 4': 'large',
  'New World Stages - Stage 5': 'large',
  'Astor Place Theatre': 'large',
  'Orpheum Theatre NYC': 'large',
  'DR2': 'large',
  'Daryl Roth Theatre': 'large',
  'Westside Theatre Upstairs': 'large',
  'Westside Theatre Upstairs - NY': 'large',

  // === Massive (1500+ capacity) ===

  // Arenas
  'Madison Square Garden': 'massive',
  'Barclays Center': 'massive',
  'Radio City Music Hall': 'massive',
  'Radio City Music Hall Tour Experience': 'massive',
  'Beacon Theatre': 'massive',
  'Carnegie Hall': 'massive',
  'Brooklyn Paramount': 'massive',
  'Kings Theatre': 'massive',
  'Brooklyn Mirage': 'massive',
  'Avant Gardner': 'massive',
  'The Brooklyn Mirage': 'massive',
  'Irving Plaza Powered By Verizon 5G': 'large',

  // Broadway theaters
  'Lena Horne Theatre': 'massive',
  'Neil Simon Theatre': 'massive',
  'Gershwin Theatre': 'massive',
  'Broadway Theatre': 'massive',
  'Broadway Theatre-New York': 'massive',
  'Ambassador Theatre': 'massive',
  'Ambassador Theatre-NY': 'massive',
  'Hudson Theatre -NY': 'massive',
  'Lyric Theatre - NY': 'massive',
  'Minskoff Theatre': 'massive',
  'Richard Rodgers Theatre': 'massive',
  'Richard Rodgers Theatre-NY': 'massive',
  'New Amsterdam Theatre': 'massive',
  'Belasco Theatre': 'massive',
  'Gerald Schoenfeld Theatre': 'massive',
  'Bernard B. Jacobs Theatre': 'massive',
  'Jacobs Theatre-NY': 'massive',
  'Imperial Theatre': 'massive',
  'Imperial Theatre - NY': 'massive',
  'Walter Kerr Theatre': 'massive',
  'John Golden Theatre': 'massive',
  'Marquis Theatre': 'massive',
  'Lunt-Fontanne Theatre': 'massive',
  'Samuel J Friedman Theatre': 'massive',
  'Circle In The Square Theatre': 'massive',
  'Eugene O\'Neill Theatre': 'massive',
  'Nederlander Theatre': 'massive',
  'Lyceum Theatre': 'massive',
  'Longacre Theatre': 'massive',
  'Lincoln Center - Vivian Beaumont Theater': 'massive',
  'Lincoln Center - Vivian Beaumont': 'massive',
  'Goldstein Theatre at Kupferberg Center for the Arts': 'massive',
  'House of the Redeemer': 'medium',

  // === Additional venues from coverage audit ===

  // Museums / attractions
  'Banksy Museum New York': 'medium',
  'The Banksy Museum': 'medium',
  'Museum of Broadway': 'medium',
  'Color Factory NYC': 'medium',
  'ARTECHOUSE NYC': 'medium',
  'Brooklyn Museum': 'large',
  'New Museum': 'medium',

  // Film venues
  'Film Forum': 'intimate',
  'Nitehawk Cinema': 'medium',
  'Nitehawk Cinema Williamsburg': 'medium',
  'Nitehawk Prospect Park': 'medium',
  'Anthology Film Archives': 'intimate',
  'BAM Rose Cinemas': 'medium',
  'Spectacle Theater': 'intimate',
  'Alamo Drafthouse': 'large',
  'Alamo Drafthouse Downtown Brooklyn': 'large',
  'Roxy Cinema': 'intimate',
  'The Roxy Cinema': 'intimate',
  'Village East by Angelika': 'medium',

  // Additional music venues
  'Rough Trade NYC': 'medium',
  'Knitting Factory Brooklyn': 'medium',
  'The Bitter End': 'intimate',
  'Zinc Bar': 'intimate',
  'The Stonewall Inn': 'intimate',
  'Silvana': 'intimate',

  // Parks / outdoor (large open spaces)
  'Central Park': 'massive',
  'Prospect Park': 'massive',
  'Brooklyn Bridge Park': 'massive',
  'The High Line': 'large',
  'Bryant Park': 'large',

  // Additional performing arts
  'Symphony Space': 'large',
  'Town Hall': 'large',
  'Apollo Theater': 'large',
  'United Palace': 'massive',
  'St. Ann\'s Warehouse': 'medium',
  'Pioneer Works': 'medium',

  // Additional comedy
  'Comedy Cellar': 'intimate',
  'Old Man Hustle BKLYN COMEDY Club': 'intimate',
  'QED Astoria': 'intimate',
  'Stand Up NY': 'intimate',

  // Bookstores / literary (all intimate)
  'Greenlight Bookstore': 'intimate',
  'Books Are Magic': 'intimate',
  'Strand Book Store': 'intimate',
  'Strand Bookstore': 'intimate',
  'McNally Jackson': 'intimate',
  'McNally Jackson Books': 'intimate',
  'Housing Works Bookstore': 'intimate',
  'Housing Works Bookstore Cafe': 'intimate',
  'The Center for Fiction': 'intimate',
  'Book Club Bar': 'intimate',
  'P&T Knitwear': 'intimate',

  // Bars / community venues
  'Union Hall': 'intimate',
  'Barbes': 'intimate',
  'Jalopy Theatre': 'intimate',
  'Good Room': 'medium',
  'Public Records': 'medium',
  'Sunny\'s Bar': 'intimate',
  'Club Cumming': 'intimate',
  'Niagara': 'intimate',
  'The Parkside Lounge': 'intimate',
};

// Build normalized size lookup
const normalizedSizeMap = new Map();
for (const [name, size] of Object.entries(VENUE_SIZE)) {
  normalizedSizeMap.set(normalizeName(name), size);
}

/**
 * Look up venue size classification.
 * Returns 'intimate', 'medium', 'large', 'massive', or null (unclassified).
 */
function lookupVenueSize(name) {
  if (!name) return null;
  return normalizedSizeMap.get(normalizeName(name)) || null;
}

// Build normalized lookup map at module load
const normalizedMap = new Map();
for (const [name, coords] of Object.entries(VENUE_MAP)) {
  const key = normalizeName(name);
  if (!normalizedMap.has(key)) {
    normalizedMap.set(key, coords);
  }
}

function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/['\-\.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strip date ranges, parenthetical junk, and trailing suffixes from venue names.
 * Handles patterns like "Metrograph (Mar 21–29)", "Film at Lincoln Center through Mar 15",
 * "Film Forum,   – Apr 2", "Bossa Nova Civic Club ( , 12–4 PM)", "IFC Center (from  )".
 */
function cleanVenueName(name) {
  if (!name) return name;
  return name
    .replace(/\s*\([^)]*\)\s*$/, '')       // strip trailing (...) parentheticals
    .replace(/\s*,?\s*through\s+.*/i, '')   // strip "through Mar 15" / ", through Apr 4"
    .replace(/\s*,\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b.*/i, '') // ", Mar 27–28"
    .replace(/\s*,\s+\s*[–—-]\s*.*/i, '')  // ",   – Apr 2"
    .replace(/\s+shows?\s+.*/i, '')         // "Lincoln Center shows Béla Tarr's..."
    .replace(/\s+series\s+continue.*/i, '') // "series continue through..."
    .trim();
}

function lookupVenue(name) {
  if (!name) return null;
  const key = normalizeName(name);
  const direct = normalizedMap.get(key);
  if (direct) return direct;

  // Try "Room at Venue" → lookup "Venue"
  const atMatch = name.match(/\bat\s+(.+)/i);
  if (atMatch) {
    const parentKey = normalizeName(atMatch[1]);
    const parent = normalizedMap.get(parentKey);
    if (parent) return parent;
  }

  // Try cleaned venue name (strip date ranges, parenthetical junk)
  const cleaned = cleanVenueName(name);
  if (cleaned && cleaned !== name) {
    const cleanedKey = normalizeName(cleaned);
    const cleanedMatch = normalizedMap.get(cleanedKey);
    if (cleanedMatch) return cleanedMatch;
  }

  return null;
}

function learnVenueCoords(name, lat, lng) {
  if (!name || isNaN(lat) || isNaN(lng)) return;
  const key = normalizeName(name);
  if (!normalizedMap.has(key)) {
    normalizedMap.set(key, { lat, lng });
  }
}

// --- Venue profiles (loaded from data/venue-profiles.json on boot) ---
const normalizedProfileMap = new Map();

try {
  const profilePath = require('path').join(__dirname, '../data/venue-profiles.json');
  const profileData = JSON.parse(require('fs').readFileSync(profilePath, 'utf8'));
  for (const [name, profile] of Object.entries(profileData)) {
    normalizedProfileMap.set(normalizeName(name), profile);
  }
  console.log(`Loaded ${normalizedProfileMap.size} venue profiles`);
} catch {
  console.log('No venue profiles found (data/venue-profiles.json missing or invalid)');
}

/**
 * Look up venue profile.
 * Returns { vibe, known_for, crowd, tip } or null.
 */
function lookupVenueProfile(name) {
  if (!name) return null;
  return normalizedProfileMap.get(normalizeName(name)) || null;
}

// --- Persistence helpers ---

const staticKeys = new Set();
for (const name of Object.keys(VENUE_MAP)) {
  staticKeys.add(normalizeName(name));
}

function exportLearnedVenues() {
  const learned = {};
  for (const [key, coords] of normalizedMap) {
    if (!staticKeys.has(key)) {
      learned[key] = coords;
    }
  }
  return learned;
}

function importLearnedVenues(map) {
  for (const [key, coords] of Object.entries(map)) {
    if (!normalizedMap.has(key)) {
      normalizedMap.set(key, coords);
    }
  }
}

// --- Nominatim geocoding fallback ---

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function geocodeVenue(name, address) {
  const query = address
    ? `${address}, New York`
    : name
      ? `${name}, New York, NY`
      : null;
  if (!query) return null;

  try {
    const params = new URLSearchParams({
      q: query, format: 'json', limit: '1',
      countrycodes: 'us', viewbox: '-74.26,40.49,-73.70,40.92', bounded: '1',
    });
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { 'User-Agent': 'PulseSMS/1.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.length) return null;

    const coords = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    // Cache for future lookups within this process
    if (name) normalizedMap.set(normalizeName(name), coords);
    return coords;
  } catch { return null; }
}

async function batchGeocodeEvents(events) {
  const { resolveNeighborhood } = require('./geo');
  const unresolved = events.filter(e => !e.neighborhood && (e.venue_name || e.venue_address));
  if (unresolved.length === 0) return;

  console.log(`Geocoding ${unresolved.length} events with missing neighborhoods...`);
  let resolved = 0;

  for (const e of unresolved) {
    // Check cache first (may have been populated by an earlier iteration)
    const cached = lookupVenue(e.venue_name);
    if (cached) {
      e.neighborhood = resolveNeighborhood(null, cached.lat, cached.lng);
      if (e.neighborhood) resolved++;
      continue;
    }

    await sleep(1100); // Nominatim rate limit: 1 req/sec
    const coords = await geocodeVenue(e.venue_name, e.venue_address);
    if (coords) {
      e.neighborhood = resolveNeighborhood(null, coords.lat, coords.lng);
      if (e.neighborhood) resolved++;
    } else {
      console.log(`Geocode miss: "${e.venue_name}" / "${e.venue_address}"`);
    }
  }

  console.log(`Geocoding done: ${resolved}/${unresolved.length} resolved`);
}

module.exports = { VENUE_MAP, VENUE_SIZE, lookupVenue, lookupVenueSize, lookupVenueProfile, learnVenueCoords, geocodeVenue, batchGeocodeEvents, exportLearnedVenues, importLearnedVenues };
